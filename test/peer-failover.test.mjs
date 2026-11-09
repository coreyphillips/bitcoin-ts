import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Chain } from '../dist/chain.js';
import { PeerConnectionError, syncPeer } from '../dist/peer.js';
import { FrameReader, frame, readLocator, versionMessage, writeHeaders } from '../dist/wire.js';

const magic = Buffer.from('fabfb5da', 'hex');

async function peer(t, services, onGetHeaders) {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const decoder = new FrameReader(magic);
    socket.on('data', chunk => {
      for (const { command, payload } of decoder.push(chunk)) {
        if (command === 'version') {
          const version = versionMessage(1).bytes;
          version.writeBigUInt64LE(services, 4);
          socket.write(Buffer.concat([frame(magic, 'version', version), frame(magic, 'verack')]));
        } else if (command === 'getheaders') {
          const reply = onGetHeaders?.(payload);
          socket.write(frame(magic, 'headers', reply ?? writeHeaders([])));
        }
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

test('automatic peer selection requires service bits and a completed handshake', async t => {
  const chain = new Chain('regtest');
  const store = { chain, headers: (headers, now) => chain.processHeaders(headers, now) };
  let ready = 0;
  const options = { timeout: 1000, requireFullNode: true, onReady: () => ready++ };
  for (const services of [1n, 8n]) {
    const endpoint = await peer(t, services);
    await assert.rejects(syncPeer(store, endpoint, options), PeerConnectionError);
    assert.equal(ready, 0);
  }
  const endpoint = await peer(t, 9n);
  await syncPeer(store, endpoint, options);
  assert.equal(ready, 1);
});

test('malformed peer replies can fail over, while local errors propagate unchanged', async t => {
  const chain = new Chain('regtest');
  const localError = new Error('test write failure');
  const store = { chain, headers() { throw localError; } };
  let stopHash;
  const endpoint = await peer(t, 9n, payload => { stopHash = readLocator(payload).stop; });
  const options = { timeout: 1000, requireFullNode: true, stopAt: '11'.repeat(32) };
  await assert.rejects(syncPeer(store, endpoint, options), error => error === localError);
  assert.equal(stopHash, options.stopAt);
  const callbackError = new Error('test callback failure');
  await assert.rejects(syncPeer(store, endpoint, { ...options, onReady() { throw callbackError; } }), error => error === callbackError);
  const malformed = await peer(t, 9n, () => Buffer.from([253]));
  await assert.rejects(syncPeer(store, malformed, options), PeerConnectionError);
});
