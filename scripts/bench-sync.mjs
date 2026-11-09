// Build this checkout and the baseline, then run: node scripts/bench-sync.mjs /path/to/baseline
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { hash160, sha256, SighashCache, taprootSighash, txid, witnessV0Sighash } from '../dist/index.js';
import { mineBlock } from '../test/fixtures/mine-block.mjs';

const perBlockBaseline = process.argv[3] === '--baseline-per-block';
if (process.argv.length !== (perBlockBaseline ? 4 : 3)) {
  throw new Error('Usage: node scripts/bench-sync.mjs /path/to/baseline-checkout [--baseline-per-block]');
}
const threads = 8;
const spendsPerBlock = 128;
const blocksPerSample = 4;
const warmupSamples = 2;
const measuredSamples = 7;
const blockTime = 1_600_000_000;
const empty = Buffer.alloc(0);
const input = (hash, index) => ({ hash, index, script: empty, sequence: 0xffffffff, witness: [] });

function benchmarkChain(genesis) {
  const keys = Array.from({ length: 64 }, (_, i) => {
    const secret = sha256(Buffer.from('offline-benchmark-key-' + i));
    const pubkey = Buffer.from(secp256k1.getPublicKey(secret));
    const keyHash = hash160(pubkey);
    return {
      secret, pubkey,
      p2wpkh: Buffer.concat([Buffer.of(0, 20), keyHash]),
      scriptCode: Buffer.concat([Buffer.of(0x76, 0xa9, 20), keyHash, Buffer.of(0x88, 0xac)]),
      p2tr: Buffer.concat([Buffer.of(0x51, 32), schnorr.getPublicKey(secret)]),
    };
  });
  const keysFor = n => [keys[2 * n % keys.length], keys[(2 * n + 1) % keys.length]];
  function outputs(n, value) {
    const [first, second] = keysFor(n);
    return [{ value, script: first.p2wpkh }, { value, script: second.p2tr }];
  }

  const blocks = [];
  function append(transactions = []) {
    blocks.push(mineBlock(blocks.at(-1)?.hash ?? genesis, blocks.length + 1, 0, transactions));
  }
  for (let i = 0; i < 100; i++) append();
  const funding = {
    version: 2, locktime: 0, inputs: [input(txid(blocks[0].coinbase), 0)],
    outputs: Array.from({ length: spendsPerBlock }, (_, n) => outputs(n, 1_000n)).flat(),
  };
  append([funding]);
  // Each spend recreates two outputs for the corresponding transaction in the next block.
  const fundingId = txid(funding);
  let previous = Array.from({ length: spendsPerBlock }, (_, n) => ({ hash: fundingId, index: 2 * n }));
  const count = (warmupSamples + measuredSamples) * blocksPerSample;
  for (let i = 0; i < count; i++) {
    const value = 1_000n - BigInt(i);
    const spends = previous.map(({ hash, index }, n) => {
      const spent = outputs(n, value);
      const tx = { version: 2, locktime: blocks.length, inputs: [input(hash, index), input(hash, index + 1)],
        outputs: outputs(n, value - 1n) };
      const [first, second] = keysFor(n);
      const cache = new SighashCache(tx, spent);
      const digest = witnessV0Sighash(tx, 0, first.scriptCode, value, 1, cache);
      const der = secp256k1.sign(digest, first.secret, { prehash: false }).toDERRawBytes();
      tx.inputs[0].witness = [Buffer.concat([der, Buffer.of(1)]), first.pubkey];
      const tapDigest = taprootSighash(tx, 1, spent, 0, undefined, undefined, 0xffffffff, cache);
      tx.inputs[1].witness = [Buffer.from(schnorr.sign(tapDigest, second.secret, Buffer.alloc(32)))];
      return tx;
    });
    append(spends);
    previous = spends.map(tx => ({ hash: txid(tx), index: 0 }));
  }
  return blocks;
}

const dir = mkdtempSync(join(tmpdir(), 'bitcoin-ts-sync-benchmark-'));
const runs = [];
try {
  const current = fileURLToPath(new URL('..', import.meta.url));
  for (const [name, checkout] of [['baseline', resolve(process.argv[2])], ['current', current]]) {
    const { ChainStore } = await import(pathToFileURL(join(checkout, 'dist/storage.js')));
    const { signatureBackend } = await import(pathToFileURL(join(checkout, 'dist/crypto.js')));
    const open = () => new ChainStore(join(dir, name), 'regtest', {}, { scriptThreads: threads });
    const store = open();
    const grouped = Boolean(store.downloadBlock) && !(name === 'baseline' && perBlockBaseline);
    runs.push({ name, open, store, grouped, backend: signatureBackend ?? 'js', samplesMs: [] });
  }

  const blocks = benchmarkChain(runs[0].store.chain.tip().tip);
  function apply({ store, grouped }, group) {
    const write = grouped ? store.downloadBlock : store.block;
    for (const block of group) {
      const verdict = write.call(store, block.bytes, blockTime);
      assert.equal(verdict.result, 'accepted', JSON.stringify(verdict));
      assert.equal(verdict.tip, block.hash);
    }
    store.flushBlocks?.(); // Include the final durable commit in the measurements.
  }
  for (const run of runs) {
    const headers = blocks.map(block => block.bytes.subarray(0, 80));
    assert.equal(run.store.headers(headers, blockTime).result, 'accepted');
    apply(run, blocks.slice(0, 101));
  }

  for (let i = 0; i < warmupSamples + measuredSamples; i++) {
    const start = 101 + i * blocksPerSample;
    const group = blocks.slice(start, start + blocksPerSample);
    for (const run of (i % 2 ? runs.toReversed() : runs)) {
      await setImmediate();
      const begin = performance.now();
      apply(run, group);
      const elapsed = performance.now() - begin;
      if (i >= warmupSamples) run.samplesMs.push(elapsed);
    }
  }
  const results = runs.map(run => {
    run.store.close();
    run.store = run.open();
    const state = { ...run.store.chain.tip(), ...run.store.chain.utxoHash() };
    const median = run.samplesMs.toSorted((a, b) => a - b)[Math.floor(measuredSamples / 2)];
    return { name: run.name, backend: run.backend, groupedCommits: run.grouped, state,
      medianMsPerBlock: median / blocksPerSample, samplesMs: run.samplesMs };
  });
  assert.deepEqual(results[0].state, results[1].state);
  assert.equal(results[0].state.tip, blocks.at(-1).hash);
  console.log(JSON.stringify({ cpu: cpus()[0].model, node: process.version, threads,
    spendsPerBlock, signaturesPerBlock: 2 * spendsPerBlock, blocksPerSample, warmupSamples, measuredSamples,
    speedup: results[0].medianMsPerBlock / results[1].medianMsPerBlock, results }, null, 2));
} finally {
  for (const run of runs) run.store.close();
  rmSync(dir, { recursive: true, force: true });
}
