import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mineBlock } from './fixtures/mine-block.mjs';
import { ChainStore, syncPeer, syncPeers } from '../dist/node.js';
import { blockInventory, FrameReader, frame, readLocator, versionMessage, writeHeaders } from '../dist/wire.js';

const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const magic = Buffer.from('fabfb5da', 'hex');
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const exec = promisify(execFile);

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bitcoin-ts-pool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function storeFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bitcoin-ts-pool-'));
  const store = new ChainStore(dir, 'regtest');
  t.after(() => {
    try { store.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return store;
}

function branch(count, tag = 0) {
  const chain = [];
  for (let i = 1; i <= count; i++) chain.push(mineBlock(chain.at(-1)?.hash ?? genesis, i, tag));
  return chain;
}

async function serve(t, chain, hooks = {}) {
  const byHash = new Map(chain.map((b, i) => [b.hash, i]));
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    const reader = new FrameReader(magic);
    const send = (command, bytes) => socket.write(frame(magic, command, bytes));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {}); // Client cancellation can race a queued test reply.
    socket.on('data', data => {
      for (const { command, payload } of reader.push(data)) {
        if (command === 'version') {
          const version = versionMessage(chain.length).bytes;
          version.writeBigUInt64LE(9n, 4);
          send('version', version);
          send('verack');
        } else if (command === 'getheaders') {
          const { locator, stop } = readLocator(payload);
          const first = locator.find(hash => byHash.has(hash));
          const after = first === undefined ? 0 : byHash.get(first) + 1;
          const last = byHash.get(stop);
          const offered = locator.length ? chain.slice(after, last === undefined ? undefined : last + 1)
            : last === undefined ? [] : [chain[last]];
          const reply = () => send('headers', writeHeaders(offered.map(b => b.bytes.subarray(0, 80))));
          if (hooks.headers) hooks.headers({ reply, socket, send });
          else reply();
        } else if (command === 'getdata') {
          const hashes = blockInventory(payload);
          const reply = () => {
            for (const hash of hashes) {
              const index = byHash.get(hash);
              assert.notEqual(index, undefined, 'requested a block outside the peer chain');
              send('block', chain[index].bytes);
            }
          };
          if (hooks.bodies) hooks.bodies({ hashes, reply, socket });
          else reply();
        } else if (command === 'pong') hooks.pong?.(socket);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return '127.0.0.1:' + server.address().port;
}

test('CLI divides witness block requests between simultaneously connected peers', async t => {
  const chain = branch(40);
  const requests = [];
  const suppliers = new Set();
  const pending = [];
  const endpoints = [];
  // Both peers must request work before either supplies a body.
  for (let i = 0; i < 2; i++) {
    endpoints.push(await serve(t, chain, { bodies({ hashes, reply }) {
      suppliers.add(i);
      requests.push(...hashes);
      pending.push(reply);
      if (suppliers.size === 2) for (const send of pending.splice(0)) send();
    } }));
  }
  const args = [cli, 'sync', '--datadir', directory(t), '--timeout', '3', '--max-peers', '2'];
  for (const endpoint of endpoints) args.push('--connect', endpoint);
  const { stdout } = await exec(process.execPath, args, { timeout: 8000 });
  assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)).tip, chain.at(-1).hash);
  assert.deepEqual(requests.sort(), chain.map(b => b.hash).sort());
  assert.equal(suppliers.size, 2);
});

test('a healthy peer takes over outstanding blocks from a disconnected supplier', async t => {
  const store = storeFor(t);
  const chain = branch(32);
  const requests = [[], []];
  let dropped;
  const endpoints = [];
  for (let i = 0; i < 2; i++) {
    endpoints.push(await serve(t, chain, { bodies({ hashes, reply, socket }) {
      requests[i].push(...hashes);
      if (dropped === undefined) {
        dropped = i;
        socket.destroy();
      } else reply();
    } }));
  }
  await syncPeers(store, endpoints, { timeout: 3000, stopAt: chain.at(-1).hash });
  const survivor = 1 - dropped;
  assert.equal(store.chain.tip().tip, chain.at(-1).hash);
  assert.ok(requests[dropped].length > 0);
  assert.deepEqual(requests[survivor].sort(), chain.map(b => b.hash).sort());
});

test('one-shot sync waits for other header replies and selects the higher-work fork', async t => {
  const store = storeFor(t);
  const short = branch(2, 1);
  const long = branch(3, 2);
  for (const block of short) assert.equal(store.block(block.bytes, 1_600_000_000).tip, block.hash);
  const staleAnswered = Promise.withResolvers();
  const a = await serve(t, short, {
    headers({ reply, send }) { reply(); send('ping', Buffer.alloc(8, 3)); },
    pong() { staleAnswered.resolve(); },
  });
  // A pong proves the synchronizer examined the first peer's empty headers reply.
  const b = await serve(t, long, {
    headers({ reply }) { staleAnswered.promise.then(reply); },
  });
  await syncPeers(store, [a, b], { timeout: 3000 });
  assert.equal(store.chain.tip().tip, long.at(-1).hash);
  assert.equal(store.chain.utxoHash().txouts, long.length);
});

test('aborting follow mode closes every socket and preserves the active tip', async t => {
  const store = storeFor(t);
  const controller = new AbortController();
  const closed = new Set();
  const acknowledged = new Set();
  const reason = new Error('test cancellation');
  const endpoints = [];
  for (let i = 0; i < 2; i++) {
    endpoints.push(await serve(t, [], {
      headers({ reply, send }) { reply(); send('ping', Buffer.alloc(8, 42)); },
      pong(socket) {
        if (acknowledged.has(i)) return;
        acknowledged.add(i);
        closed.add(once(socket, 'close'));
        if (acknowledged.size === 2) controller.abort(reason);
      },
    }));
  }
  await assert.rejects(syncPeers(store, endpoints, {
    follow: true, timeout: 3000, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
  }), error => error === reason || error.name === 'AbortError');
  await Promise.all(closed);
  assert.equal(acknowledged.size, 2);
  assert.equal(store.chain.tip().tip, genesis);
});

test('bounded sync fails if all responsive peers lack the requested target', { timeout: 5000 }, async t => {
  const store = storeFor(t);
  const endpoints = [await serve(t, []), await serve(t, [])];
  await assert.rejects(syncPeers(store, endpoints, { timeout: 150, stopAt: 'aa'.repeat(32) }));
  assert.equal(store.chain.tip().tip, genesis);
});

test('a timed-out body request is retried on the peer serving later blocks', { timeout: 6000 }, async t => {
  const store = storeFor(t);
  const chain = branch(12);
  const endpoints = [];
  let stalled;
  const served = [];
  for (let i = 0; i < 2; i++) {
    endpoints.push(await serve(t, chain, { bodies({ hashes, reply }) {
      // Withhold the first block, so the active tip cannot move while later bodies arrive.
      if (hashes.includes(chain[0].hash) && stalled === undefined) stalled = i;
      if (i === stalled) return;
      served.push(...hashes);
      reply();
    } }));
  }
  await syncPeers(store, endpoints, { timeout: 250, stopAt: chain.at(-1).hash });
  assert.equal(store.chain.tip().tip, chain.at(-1).hash);
  assert.ok(served.includes(chain[0].hash));
});


test('the single-peer library call reports disconnects to its caller in follow mode', { timeout: 3000 }, async t => {
  const store = storeFor(t);
  const endpoint = await serve(t, [], { headers({ socket }) { socket.destroy(); } });
  await assert.rejects(syncPeer(store, endpoint, { follow: true, timeout: 500 }), /Peer closed|reset/i);
});
