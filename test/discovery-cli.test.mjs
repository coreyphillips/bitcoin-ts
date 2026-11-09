import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainStore } from '../dist/storage.js';
import { FrameReader, frame, versionMessage, writeHeaders } from '../dist/wire.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/discovery-network.mjs', import.meta.url));
const answers = ['8.8.8.8', '1.1.1.1'];
const mainGenesis = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const regtestGenesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';

function setup(t, candidates = answers) {
  const dir = mkdtempSync(join(tmpdir(), 'bitcoin-ts-discovery-'));
  const trace = join(dir, 'requests.jsonl');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = port => {
    writeFileSync(trace, '');
    return { ...process.env, BITCOIN_TEST_NETWORK: JSON.stringify({ trace, port, answers: candidates }) };
  };
  return {
    dir,
    env,
    run(port, ...args) {
      return exec(process.execPath, ['--import', preload, cli, 'sync', '--datadir', join(dir, 'chain'), '--timeout', '2', ...args], {
        env: env(port),
        timeout: 8000,
      });
    },
    requests() {
      return readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
  };
}

async function startPeer(t, magicHex, onPong) {
  let dropNext = false;
  const magic = Buffer.from(magicHex, 'hex');
  const sockets = new Set();
  const server = createServer(socket => {
    if (dropNext) {
      dropNext = false;
      socket.destroy();
      return;
    }
    const reader = new FrameReader(magic);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      for (const msg of reader.push(chunk)) {
        if (msg.command === 'version') {
          const version = versionMessage(0).bytes;
          version.writeBigUInt64LE(9n, 4); // NODE_NETWORK | NODE_WITNESS
          socket.write(frame(magic, 'version', version));
          socket.write(frame(magic, 'verack'));
        }
        if (msg.command === 'getheaders') {
          socket.write(frame(magic, 'headers', writeHeaders([])));
          if (onPong) socket.write(frame(magic, 'ping', Buffer.alloc(8, 42)));
        }
        if (msg.command === 'pong') onPong?.(socket);
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, dropNextConnection() { dropNext = true; } };
}

function tip(stdout) {
  return JSON.parse(stdout.trim().split('\n').at(-1)).tip;
}

test('one connection slot discovers alternatives and remembers a peer on restart', async t => {
  const cli = setup(t);
  const peer = await startPeer(t, 'f9beb4d9');
  peer.dropNextConnection();
  const first = await cli.run(peer.port, '--max-peers', '1');
  assert.equal(tip(first.stdout), mainGenesis);
  const trace = cli.requests();
  assert.ok(trace.some(entry => entry.query));
  const dials = trace.filter(entry => entry.host);
  assert.deepEqual(dials.map(entry => entry.host).sort(), [...answers].sort());
  assert.ok(dials.every(entry => entry.port === 8333));

  const second = await cli.run(peer.port, '--max-peers', '1');
  assert.equal(tip(second.stdout), mainGenesis);
  // A previously useful peer can bootstrap a new process with DNS unavailable.
  assert.deepEqual(cli.requests(), [dials.at(-1)]);

  peer.dropNextConnection();
  const recovered = await cli.run(peer.port, '--max-peers', '1');
  assert.equal(tip(recovered.stdout), mainGenesis);
  const retry = cli.requests();
  assert.deepEqual(retry[0], dials.at(-1));
  assert.ok(retry.some(entry => entry.query));
  assert.deepEqual(retry.filter(entry => entry.host).at(-1), dials[0]);
});

test('an explicit peer bypasses discovery and uses the existing regtest default', async t => {
  const cli = setup(t);
  const { port } = await startPeer(t, 'fabfb5da');
  const result = await cli.run(port, '--connect', '127.0.0.1:' + port, '--script-threads', '2');
  assert.equal(tip(result.stdout), regtestGenesis);
  assert.deepEqual(cli.requests(), [{ host: '127.0.0.1', port }]);
});

test('invalid verification thread counts fail before opening the chain or dialing peers', async t => {
  const cli = setup(t);
  for (const count of ['0', '17', '1.5']) {
    await assert.rejects(cli.run(0, '--script-threads', count), error => error.code === 1 && error.stderr.includes('script-threads'));
    assert.deepEqual(cli.requests(), []);
    assert.equal(existsSync(join(cli.dir, 'chain')), false);
  }
});

test('private networks require an explicit peer without consulting public DNS', async t => {
  for (const args of [['--network', 'regtest'], ['--network', 'signet', '--options', '{"signetchallenge":"51"}']]) {
    const cli = setup(t);
    await assert.rejects(cli.run(0, ...args), error => error.code === 1 && error.stderr.includes('--connect'));
    assert.deepEqual(cli.requests(), []);
  }
});

test('startup follows eight simultaneous mainnet peers and fills a vacated slot', async t => {
  const candidates = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '4.2.2.2', '208.67.222.222',
    '76.76.2.0', '64.6.64.6', '94.140.14.14', '80.80.80.80'];
  const network = setup(t, candidates);
  const ready = Promise.withResolvers();
  const responsive = new Set();
  let dropped;
  const peer = await startPeer(t, 'f9beb4d9', socket => {
    responsive.add(socket);
    const live = [...responsive].filter(s => !s.destroyed);
    if (live.length !== 8) return;
    if (!dropped) {
      if (network.requests().filter(event => event.host).length !== 8) {
        ready.reject(new Error('Dialed a ninth peer before a slot opened'));
        return;
      }
      dropped = live[0];
      dropped.destroy();
    } else if (responsive.size === 9) {
      ready.resolve();
    }
  });
  const child = spawn(process.execPath, ['--import', preload, cli], {
    cwd: network.dir, env: network.env(peer.port), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => ready.reject(new Error('Timed out waiting for replacement peer: ' + stderr)), 8000);
  try {
    await Promise.race([ready.promise, exited.then(([code]) => {
      throw new Error('Node exited before following a replacement peer (' + code + '): ' + stderr);
    })]);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
  const peers = network.requests().filter(event => event.host).map(event => event.host);
  assert.deepEqual([...peers].sort(), [...candidates].sort());
  const directory = join(network.dir, 'data', 'main');
  assert.ok(existsSync(join(directory, 'chain.sqlite')));
  const store = new ChainStore(directory, 'main');
  try {
    assert.equal(store.chain.tip().tip, mainGenesis);
    assert.equal(store.knownPeers().length, 8);
    assert.ok(store.knownPeers().includes(peers.at(-1)));
  } finally { store.close(); }
});
