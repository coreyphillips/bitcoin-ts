import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Chain, parseBlock, txid } from '../dist/index.js';
import { applyChanges, connectBlock } from '../dist/coins.js';
import { mineBlock } from './fixtures/mine-block.mjs';

const [fixture] = JSON.parse(readFileSync(new URL('./fixtures/regtest.json', import.meta.url)));

test('witness validation is scoped to the received bytes and preserves P2P and RPC verdicts', () => {
  const original = Buffer.from(fixture.block, 'hex');
  const mutated = Buffer.from(original);
  // Change only the reserved witness value. Both encodings have the same block hash.
  parseBlock(mutated).transactions[0].inputs[0].witness[0][0] ^= 1;
  for (const [origin, reason] of [['p2p', 'block-mutated'], ['rpc', 'bad-witness-merkle-match']]) {
    const chain = new Chain('regtest');
    assert.equal(chain.processBlock(mutated, 1_600_000_000, origin).reason, reason);
    assert.equal(chain.processBlock(original, 1_600_000_000, origin).tip, fixture.hash);
    if (origin === 'p2p') assert.equal(chain.processBlock(mutated, 1_600_000_000, origin).reason, reason);
  }
});

test('undo reuses a spent coin and restores the pre-block value of an output spent in the same block', () => {
  const chain = new Chain('regtest');
  const originalId = Buffer.alloc(32, 7);
  const originalKey = originalId.toString('hex') + '00000000';
  const originalCoin = { height: 1, coinbase: false, output: { value: 100n, script: Buffer.of(0x51) } };
  const spend = (hash, value) => ({ version: 1, locktime: 0,
    inputs: [{ hash, index: 0, sequence: 0xffffffff, script: Buffer.alloc(0), witness: [] }],
    outputs: [{ value, script: Buffer.of(0x51) }],
  });
  const first = spend(originalId, 90n);
  const intermediateKey = txid(first).toString('hex') + '00000000';
  const second = spend(txid(first), 80n);
  const block = parseBlock(mineBlock(chain.tip().tip, 101, 0, [first, second]).bytes);
  for (const onBip34Chain of [false, true]) {
    const view = new Map([[originalKey, originalCoin]]);
    // When the BIP30 duplicate check is skipped, an overwritten output's pre-block value
    // must still be recoverable, even if another transaction spends its replacement.
    if (onBip34Chain) view.set(intermediateKey, { ...originalCoin, height: 2 });
    const before = new Map(view);
    const reads = [];
    view.get = key => { reads.push(key); return Map.prototype.get.call(view, key); };
    const undo = connectBlock(block, 101, 0, () => 0, view, chain.params, onBip34Chain);
    assert.equal(reads.filter(key => key === originalKey).length, 1);
    assert.equal(reads.filter(key => key === intermediateKey).length, Number(onBip34Chain));
    assert.equal(view.has(intermediateKey), false);
    applyChanges(view, undo);
    assert.deepEqual(new Map(view), before);
  }
});
