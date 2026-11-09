import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainStore } from '../dist/storage.js';
import { FrameReader, frame, readLocator, versionMessage, writeHeaders, WITNESS_BLOCK, MAX_PAYLOAD, displayHash } from '../dist/wire.js';
import { Reader } from '../dist/codec.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const blocks = JSON.parse(readFileSync(new URL('./fixtures/regtest.json', import.meta.url)));
const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const magic = Buffer.from('fabfb5da', 'hex');

function datadir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bitcoin-ts-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('wire reader accepts fragmented frames and drops an incorrect checksum', () => {
  const decoder = new FrameReader(magic);
  const bad = frame(magic, 'verack');
  bad[20] ^= 0xff;
  const encoded = Buffer.concat([bad, frame(magic, 'ping', Buffer.alloc(8, 3)), frame(magic, 'verack')]);
  const frames = [];
  for (const byte of encoded) frames.push(...decoder.push(Buffer.of(byte)));
  assert.deepEqual(frames, [{ command: 'ping', payload: Buffer.alloc(8, 3) }, { command: 'verack', payload: Buffer.alloc(0) }]);
  const large = frame(magic, 'block');
  large.writeUInt32LE(MAX_PAYLOAD + 1, 16);
  assert.throws(() => [...decoder.push(large)], /too large/);
});

test('a data directory locks its network and concurrent writer', t => {
  const dir = datadir(t);
  const store = new ChainStore(dir, 'regtest');
  try {
    assert.throws(() => new ChainStore(dir, 'regtest'), /locked|busy/i);
  } finally { store.close(); }
  assert.throws(() => new ChainStore(dir, 'main'), /different network/);
  const reopened = new ChainStore(dir, 'regtest');
  try { assert.equal(reopened.chain.tip().tip, genesis); } finally { reopened.close(); }
});

test('CLI downloads witness blocks and resumes across process restarts', { timeout: 20000 }, async t => {
  const dir = datadir(t);
  let offer = 2;
  const requests = [];
  const locators = [];
  const sockets = new Set();
  const server = createServer(socket => {
    const decoder = new FrameReader(magic);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const send = (command, payload) => socket.write(frame(magic, command, payload));
    socket.on('data', chunk => {
      for (const msg of decoder.push(chunk)) {
        if (msg.command === 'version') {
          send('version', versionMessage(offer).bytes);
          send('verack');
        } else if (msg.command === 'getheaders') {
          const { locator } = readLocator(msg.payload);
          locators.push(locator[0]);
          const last = blocks.findIndex(b => b.hash === locator[0]);
          send('headers', writeHeaders(blocks.slice(last + 1, offer).map(b => Buffer.from(b.block, 'hex').subarray(0, 80))));
        } else if (msg.command === 'getdata') {
          const r = new Reader(msg.payload);
          const n = r.compact();
          for (let i = 0; i < n; i++) {
            const kind = r.u32();
            const hash = displayHash(r.read(32));
            requests.push({ kind, hash });
            const b = blocks.find(b => b.hash === hash);
            if (b) send('block', Buffer.from(b.block, 'hex'));
          }
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = '127.0.0.1:' + server.address().port;
  const run = async (command, ...args) => {
    const {stdout} = await exec(process.execPath, [cli, command, '--datadir', dir, ...args]);
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  const first = await run('sync', '--connect', endpoint, '--stop-at', blocks[1].hash);
  assert.equal(first.event, 'stopped');
  assert.equal(first.hash_serialized_3, blocks[1].utxo.hash_serialized_3);
  offer = 3;
  const next = await run('sync', '--connect', endpoint);
  assert.equal(next.tip, blocks[2].hash);
  assert.equal(next.height, 3);
  assert.equal(next.hash_serialized_3, blocks[2].utxo.hash_serialized_3);
  assert.deepEqual(locators, [genesis, blocks[1].hash]);
  assert.deepEqual(requests, blocks.map(b => ({ kind: WITNESS_BLOCK, hash: b.hash })));
  assert.equal((await run('status')).tip, next.tip);
});
