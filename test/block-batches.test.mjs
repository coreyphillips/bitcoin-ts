import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Chain } from '../dist/chain.js';
import { ChainStore } from '../dist/storage.js';
import { mineBlock } from './fixtures/mine-block.mjs';

const now = 1_600_000_000;
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/regtest.json', import.meta.url)));

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bitcoin-ts-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('an interrupted download recovers the committed group and can replay the remaining blocks', t => {
  const dir = directory(t);
  const expected = new Chain('regtest');
  const bodies = [];
  for (let height = 1; height <= 34; height++) {
    const block = mineBlock(expected.tip().tip, height, 0);
    bodies.push(block.bytes);
    expected.processBlock(block.bytes, now);
  }
  const fixture = fileURLToPath(new URL('./fixtures/crash-block-batch.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [fixture, dir], {
    input: JSON.stringify(bodies.map(block => block.toString('hex'))), timeout: 10_000,
  });
  assert.equal(child.signal, 'SIGKILL', child.stderr?.toString());
  const store = new ChainStore(dir, 'regtest');
  try {
    assert.equal(store.chain.tip().height, 32);
    const reference = new Chain('regtest');
    for (const block of bodies.slice(0, 32)) reference.processBlock(block, now);
    assert.deepEqual(store.chain.tip(), reference.tip());
    assert.deepEqual(store.chain.utxoHash(), reference.utxoHash());
    for (const block of bodies.slice(32)) assert.equal(store.downloadBlock(block, now).result, 'accepted');
    store.flushBlocks();
    assert.deepEqual(store.chain.tip(), expected.tip());
    assert.deepEqual(store.chain.utxoHash(), expected.utxoHash());
  } finally { store.close(); }
});

test('a local write failure rolls back the entire partial download group', t => {
  const dir = directory(t);
  const [first, second, third] = fixtures;
  let store = new ChainStore(dir, 'regtest');
  store.block(Buffer.from(first.block, 'hex'), now);
  store.close();
  const db = new DatabaseSync(join(dir, 'chain.sqlite'));
  try {
    db.exec(`CREATE TRIGGER interrupt_write BEFORE INSERT ON meta
      WHEN NEW.key = 'tip' AND NEW.value = '${third.hash}'
      BEGIN SELECT RAISE(ABORT, 'interrupted tip write'); END;`);
  } finally { db.close(); }
  store = new ChainStore(dir, 'regtest');
  try {
    assert.equal(store.downloadBlock(Buffer.from(second.block, 'hex'), now).tip, second.hash);
    assert.throws(() => store.downloadBlock(Buffer.from(third.block, 'hex'), now), /interrupted tip write/);
    assert.throws(() => store.chain.tip(), /closed/);
  } finally { store.close(); }
  store = new ChainStore(dir, 'regtest');
  try {
    assert.equal(store.chain.tip().tip, first.hash);
    assert.deepEqual(store.chain.utxoHash(), first.utxo);
    assert.equal(store.chain.hasHeader(second.hash), false);
  } finally { store.close(); }
});
