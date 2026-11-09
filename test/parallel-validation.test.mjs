import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import {
  legacySighash, parseTransaction, serializeTransaction, sha256, SighashCache,
  taprootSighash, txid, witnessV0Sighash,
} from '../dist/index.js';
import { pushData } from '../dist/script.js';
import { ScriptPool } from '../dist/script-pool.js';
import { ChainStore } from '../dist/storage.js';
import { mineBlock } from './fixtures/mine-block.mjs';

const now = 1_600_000_000;

function input(hash, index) {
  return { hash, index, sequence: 0xffffffff, script: Buffer.alloc(0), witness: [] };
}

// A single large transaction spends three types of output created earlier in the same block.
// The varied amounts and scripts exercise the all-input Taproot signature hash in each worker.
function signedSpends(reward) {
  const key = Buffer.alloc(32, 1);
  const pubkey = secp256k1.getPublicKey(key);
  const payToKey = Buffer.concat([pushData(Buffer.from(pubkey)), Buffer.of(0xac)]);
  const witnessScript = Buffer.concat([Buffer.of(0, 32), sha256(payToKey)]);
  const taproot = Buffer.concat([Buffer.of(0x51, 32), schnorr.getPublicKey(key)]);
  const scripts = [payToKey, witnessScript, taproot];
  const funding = {
    version: 2, locktime: 0, inputs: [input(reward, 0)],
    outputs: Array.from({ length: 144 }, (_, i) => ({ value: 1_000n + BigInt(i), script: scripts[i % 3] })),
  };
  const fundingId = txid(funding);
  const spend = {
    version: 2, locktime: 0, inputs: funding.outputs.map((_, i) => input(fundingId, i)),
    outputs: [{ value: 100_000n, script: Buffer.of(0x51) }],
  };
  const cache = new SighashCache(spend, funding.outputs);
  for (const [i, txin] of spend.inputs.entries()) {
    if (i % 3 === 2) {
      const digest = taprootSighash(spend, i, funding.outputs, 0, undefined, undefined, 0xffffffff, cache);
      txin.witness = [Buffer.from(schnorr.sign(digest, key, Buffer.alloc(32)))];
    } else {
      const digest = i % 3 === 0
        ? legacySighash(spend, i, payToKey, 1)
        : witnessV0Sighash(spend, i, payToKey, funding.outputs[i].value, 1, cache);
      const signature = secp256k1.sign(digest, key, { prehash: false }).toDERRawBytes();
      const withHashType = Buffer.concat([signature, Buffer.of(1)]);
      if (i % 3 === 0) txin.script = pushData(withHashType);
      else txin.witness = [withHashType, payToKey];
    }
  }
  return { funding, spend };
}

function buildBranches(genesis) {
  const mature = [];
  let parent = genesis;
  for (let height = 1; height <= 100; height++) {
    const block = mineBlock(parent, height, 0);
    mature.push(block);
    parent = block.hash;
  }
  const { funding, spend } = signedSpends(txid(mature[0].coinbase));
  const good = mineBlock(parent, 101, 1, [funding, spend]);
  const malformed = parseTransaction(serializeTransaction(spend));
  // Earlier input 47 fails its Schnorr signature. Later input 96 fails DER decoding immediately.
  malformed.inputs[47].witness[0][12] ^= 1;
  malformed.inputs[96].script = pushData(Buffer.of(1, 1));
  const multipleErrors = mineBlock(parent, 101, 2, [funding, malformed]);
  malformed.inputs[47] = spend.inputs[47];
  const badLegacy = mineBlock(parent, 101, 3, [funding, malformed]);
  // Input 142 is in a different lane from the first input. This substitute is valid DER but
  // signs a different input's amount and outpoint.
  malformed.inputs[96] = spend.inputs[96];
  malformed.inputs[142].witness[0] = spend.inputs[139].witness[0];
  const badWitness = mineBlock(parent, 101, 4, [funding, malformed]);
  const competing = mineBlock(parent, 101, 5);
  const longer = mineBlock(competing.hash, 102, 0);
  return { mature, good, multipleErrors, badLegacy, badWitness, competing, longer };
}

test('parallel block validation preserves script error order, UTXOs, and reorgs with signed inputs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bitcoin-ts-script-threads-'));
  const workers = [];
  const exits = [];
  const stores = [];
  function open(name, scriptThreads) {
    const store = new ChainStore(join(dir, name), 'regtest', {}, { scriptThreads });
    stores.push(store);
    return store;
  }
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const onWorker = worker => {
    workers.push(worker);
    exits.push(new Promise(resolve => worker.once('exit', resolve)));
  };
  process.on('worker', onWorker);
  t.after(() => process.off('worker', onWorker));

  const serial = open('serial', 1);
  const parallel = open('parallel', 4);
  const branches = buildBranches(serial.chain.tip().tip);

  function submit(block) {
    const expected = serial.block(block.bytes, now);
    assert.deepEqual(parallel.block(block.bytes, now), expected);
    return expected;
  }
  for (const block of branches.mature) assert.equal(submit(block).tip, block.hash);
  const oldTip = serial.chain.tip().tip;
  const oldCoins = serial.chain.utxoHash();
  for (const [block, reason] of [
    [branches.multipleErrors, 'Invalid Schnorr signature'],
    [branches.badLegacy, 'Non-canonical DER signature'],
    [branches.badWitness, 'Script evaluated without error but finished with a false/empty top stack element'],
  ]) {
    assert.deepEqual(submit(block), {
      result: 'invalid', reason: 'block-script-verify-flag-failed (' + reason + ')', height: 100, tip: oldTip,
    });
    assert.deepEqual(parallel.chain.utxoHash(), oldCoins);
  }

  assert.equal(submit(branches.good).tip, branches.good.hash);
  const goodCoins = serial.chain.utxoHash();
  assert.deepEqual(parallel.chain.utxoHash(), goodCoins);
  await setImmediate();
  assert.equal(workers.length, 3, 'four verification threads include the calling thread');

  assert.equal(submit(branches.competing).tip, branches.good.hash);
  assert.equal(submit(branches.longer).tip, branches.longer.hash);
  assert.notDeepEqual(parallel.chain.utxoHash(), goodCoins);
  assert.deepEqual(parallel.chain.utxoHash(), serial.chain.utxoHash());
  // Reactivate the signed branch after losing one of its verification workers.
  await workers[0].terminate();
  assert.deepEqual(parallel.invalidate(branches.competing.hash), serial.invalidate(branches.competing.hash));
  assert.equal(parallel.chain.tip().tip, branches.good.hash);
  assert.deepEqual(parallel.chain.utxoHash(), goodCoins);
  parallel.close();
  await Promise.all(exits);

  const reopened = open('parallel', 1);
  assert.deepEqual(reopened.chain.tip(), serial.chain.tip());
  assert.deepEqual(reopened.chain.utxoHash(), goodCoins);
});

test('reused workers apply each block\'s active script flags', t => {
  const pool = new ScriptPool(4);
  t.after(() => pool.close());
  const funding = Buffer.alloc(32, 2);
  const inputs = Array.from({ length: 64 }, (_, index) => input(funding, index));
  const spent = inputs.map(() => ({ value: 100n, script: Buffer.of(0x51) }));
  // Only the last lane sees this Taproot key-path spend with an invalid signature.
  spent[63].script = Buffer.concat([Buffer.of(0x51, 32), schnorr.getPublicKey(Buffer.alloc(32, 1))]);
  inputs[63].witness = [Buffer.alloc(64)];
  const checks = [{ tx: { version: 2, locktime: 0, inputs, outputs: [spent[0]] }, spent }];
  const flags = new Set(['P2SH', 'WITNESS']);
  assert.equal(pool.verify(checks, flags), 'OK');
  flags.add('TAPROOT');
  assert.equal(pool.verify(checks, flags), 'SCHNORR_SIG');
  flags.delete('TAPROOT');
  assert.equal(pool.verify(checks, flags), 'OK');
});
