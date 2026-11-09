import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { parseBlock } from '../dist/block.js';
import { compactSize, varBytes } from '../dist/codec.js';
import { blockProof, compactToTarget, targetToCompact } from '../dist/pow.js';
import { pushData } from '../dist/script-encoding.js';
import { legacySighash } from '../dist/sighash.js';
import { validSignetSolution } from '../dist/signet.js';
import { txid } from '../dist/tx.js';

test('compact targets handle sign, underflow, overflow and the sign-bit carry', () => {
  assert.equal(blockProof(0x1d00ffff), 0x100010001n);
  assert.equal(compactToTarget(0x01123456), 0x12n);
  assert.equal(targetToCompact(0x80n), 0x02008000);
  for (const bits of [0x01003456, 0x04923456, 0xff123456]) assert.equal(compactToTarget(bits), 0n);
});

test('signet solution signs the modified merkle root and block time', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/regtest.json', import.meta.url)))[0];
  const block = parseBlock(Buffer.from(fixture.block, 'hex'));
  const coinbase = block.transactions[0];
  const commitment = coinbase.outputs.at(-1);
  const prefix = Buffer.from(commitment.script);
  const marker = Buffer.from('ecc7daa2', 'hex');
  // The signing coinbase commits to the marker with its solution removed.
  commitment.script = Buffer.concat([prefix, pushData(marker)]);
  const header = block.header.raw;
  const data = Buffer.concat([header.subarray(0, 36), txid(coinbase), header.subarray(68, 72)]);
  const privateKey = Buffer.alloc(32);
  privateKey[31] = 1;
  const publicKey = Buffer.from(secp256k1.getPublicKey(privateKey, true));
  const challenge = Buffer.concat([pushData(publicKey), Buffer.of(0xac)]);
  const toSpend = {
    version: 0, locktime: 0, outputs: [{ value: 0n, script: challenge }],
    inputs: [{ hash: Buffer.alloc(32), index: 0xffffffff, sequence: 0, script: Buffer.concat([Buffer.of(0), pushData(data)]), witness: [] }],
  };
  const toSign = {
    version: 0, locktime: 0, outputs: [{ value: 0n, script: Buffer.of(0x6a) }],
    inputs: [{ hash: txid(toSpend), index: 0, sequence: 0, script: Buffer.alloc(0), witness: [] }],
  };
  const digest = legacySighash(toSign, 0, challenge, 1);
  const signature = secp256k1.sign(digest, privateKey, { prehash: false }).toDERRawBytes();
  const scriptSig = pushData(Buffer.concat([signature, Buffer.of(1)]));
  const solution = Buffer.concat([varBytes(scriptSig), compactSize(0)]);
  commitment.script = Buffer.concat([prefix, pushData(Buffer.concat([marker, solution]))]);
  block.ids[0] = txid(coinbase);
  assert.equal(validSignetSolution(block, challenge), true);
  header[68] ^= 1;
  assert.equal(validSignetSolution(block, challenge), false);
});
