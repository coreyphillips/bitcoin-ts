import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChainStore } from '../../dist/storage.js';

// Exit without running shutdown handlers or closing SQLite, leaving a hot rollback journal.
const store = new ChainStore(process.argv[2], 'regtest');
const blocks = JSON.parse(readFileSync(0, 'utf8'));
for (const hex of blocks) {
  assert.equal(store.downloadBlock(Buffer.from(hex, 'hex'), 1_600_000_000).result, 'accepted');
}
process.kill(process.pid, 'SIGKILL');
