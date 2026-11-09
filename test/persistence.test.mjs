import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChainStore } from '../dist/storage.js';
import { Chain, txid } from '../dist/index.js';
import { mineBlock } from './fixtures/mine-block.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/regtest.json', import.meta.url)));
const now = 1_600_000_000;
const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';

function openStore(t) {
  const path = mkdtempSync(join(tmpdir(), 'bitcoin-ts-branches-'));
  let current = new ChainStore(path, 'regtest');
  t.after(() => {
    try { current.close(); } finally { rmSync(path, { recursive: true, force: true }); }
  });
  return {
    get current() { return current; },
    reopen(whileClosed) {
      current.close();
      if (whileClosed) {
        const sql = new DatabaseSync(join(path, 'chain.sqlite'));
        try { whileClosed(sql); } finally { sql.close(); }
      }
      current = new ChainStore(path, 'regtest');
    },
  };
}

test('reopening preserves undo for spent coins, competing blocks and operator invalidation', t => {
  const db = openStore(t);
  const fork = new Chain('regtest');
  let parent = genesis;
  let firstReward;
  for (let height = 1; height <= 100; height++) {
    const block = mineBlock(parent, height, 0);
    assert.equal(db.current.block(block.bytes, now, true).tip, block.hash);
    assert.equal(fork.processBlock(block.bytes, now).tip, block.hash);
    if (height === 1) firstReward = txid(block.coinbase);
    parent = block.hash;
  }
  const spend = {
    version: 2, locktime: 0,
    inputs: [{ hash: firstReward, index: 0, script: Buffer.alloc(0), sequence: 0xffffffff, witness: [] }],
    outputs: [{ value: 4_900_000_000n, script: Buffer.of(0x51) }],
  };
  const active = mineBlock(parent, 101, 1, [spend]);
  const competing = mineBlock(parent, 101, 2);
  assert.equal(db.current.block(active.bytes, now, true).tip, active.hash);
  assert.equal(db.current.block(competing.bytes, now, true).tip, active.hash);
  assert.equal(fork.processBlock(competing.bytes, now).tip, competing.hash);
  const before = db.current.chain.utxoHash();
  assert.notDeepEqual(before, fork.utxoHash());

  db.reopen();
  assert.equal(db.current.chain.tip().tip, active.hash);
  assert.deepEqual(db.current.chain.utxoHash(), before);
  assert.equal(db.current.invalidate(active.hash).tip, competing.hash);
  // Undo restores the mature coin with its original amount, height, and coinbase flag.
  assert.deepEqual(db.current.chain.utxoHash(), fork.utxoHash());
  db.reopen();
  assert.deepEqual(db.current.chain.tip(), fork.tip());
  assert.deepEqual(db.current.chain.utxoHash(), fork.utxoHash());
  assert.equal(db.current.chain.tips().tips.find(tip => tip.hash === active.hash)?.status, 'invalid');
  assert.equal(db.current.block(active.bytes, now, true).result, 'invalid');
});

test('header-only branch accepts missing bodies after reopen', t => {
  const db = openStore(t);
  const blocks = fixtures.map(item => Buffer.from(item.block, 'hex'));
  assert.equal(db.current.block(blocks[0], now, true).tip, fixtures[0].hash);
  const headers = blocks.slice(1).map(block => block.subarray(0, 80));
  assert.equal(db.current.headers(headers, now).best_header, fixtures[2].hash);
  db.reopen();
  assert.equal(db.current.chain.tip().tip, fixtures[0].hash);
  assert.equal(db.current.chain.tips().tips.find(tip => tip.hash === fixtures[2].hash)?.status, 'headers-only');
  // The child body is known, but its parent still has only a header.
  assert.equal(db.current.block(blocks[2], now, true).tip, fixtures[0].hash);
  db.reopen();
  assert.equal(db.current.block(blocks[1], now, true).tip, fixtures[2].hash);
  db.reopen();
  assert.equal(db.current.chain.tip().tip, fixtures[2].hash);
  assert.deepEqual(db.current.chain.utxoHash(), fixtures[2].utxo);
});

test('a failed tip write rolls back the entire block and permits retry after reopen', t => {
  const db = openStore(t);
  const first = fixtures[0], second = fixtures[1];
  const bytes = Buffer.from(second.block, 'hex');
  assert.equal(db.current.block(Buffer.from(first.block, 'hex'), now).tip, first.hash);
  const before = db.current.chain.tip();

  // At this point in block connection the header, body, UTXOs and undo have been written.
  db.reopen(sql => sql.exec(`
    CREATE TRIGGER interrupt_tip BEFORE INSERT ON meta WHEN NEW.key = 'tip'
    BEGIN SELECT RAISE(ABORT, 'interrupted tip write'); END;
  `));
  const priorView = db.current.chain;
  assert.throws(() => db.current.block(bytes, now), /interrupted tip write/);
  assert.throws(() => priorView.tip(), /closed/i);
  assert.throws(() => db.current.block(bytes, now), /closed/i);

  db.reopen();
  assert.deepEqual(db.current.chain.tip(), before);
  assert.deepEqual(db.current.chain.utxoHash(), first.utxo);
  assert.equal(db.current.chain.hasHeader(second.hash), false);
  assert.equal(db.current.chain.bestHeader().hash, first.hash);
  db.reopen(sql => {
    const row = sql.prepare('SELECT 1 FROM blocks WHERE hash = ?').get(Buffer.from(second.hash, 'hex'));
    assert.equal(row, undefined);
    sql.exec('DROP TRIGGER interrupt_tip');
  });
  assert.equal(db.current.block(bytes, now).result, 'accepted');
  db.reopen();
  assert.equal(db.current.chain.tip().tip, second.hash);
  assert.deepEqual(db.current.chain.utxoHash(), second.utxo);
});
