import { createConnection, isIP } from 'node:net';
import { hash256 } from './codec.js';
import type { ChainStore } from './storage.js';
import {
  FrameReader, blockInventory, checkVersion, displayHash, frame, getBlocks,
  getHeaders, readHeaders, readLocator, versionMessage, writeHeaders,
} from './wire.js';

export interface SyncOptions {
  stopAt?: string;
  follow?: boolean;
  /** Milliseconds allowed for a handshake, request, or a target without progress. */
  timeout?: number;
  onTip?: (hash: string, height: number) => void;
}

function endpoint(address: string, defaultPort: number) {
  // Bare IPv6 uses the default port. Use [IPv6]:port for a non-default port.
  if (isIP(address) === 6) return { host: address, port: defaultPort };
  const parsed = /^(?:\[([^\]]+)\]|([^:\s/]+))(?::([0-9]+))?$/.exec(address);
  if (!parsed || (parsed[1] && isIP(parsed[1]) !== 6)) throw new Error('Invalid peer address');
  const port = parsed[3] ? Number(parsed[3]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid peer port');
  return { host: parsed[1] ?? parsed[2], port };
}

/** Synchronize validated blocks from one v1 peer and persist each accepted arrival. */
export async function syncPeer(store: ChainStore, address: string, options: SyncOptions = {}): Promise<void> {
  const { chain } = store;
  const target = options.stopAt?.toLowerCase();
  if (target !== undefined && !/^[0-9a-f]{64}$/.test(target)) throw new Error('Invalid target block hash');
  if (chain.tip().tip === target) return;
  const timeout = options.timeout ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid synchronization timeout');
  const peer = endpoint(address, chain.params.port);
  const magic = chain.params.magic;
  const frames = new FrameReader(magic);
  const version = versionMessage(chain.tip().height);

  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ ...peer, noDelay: true });
    let handshake: 'version' | 'verack' | 'ready' = 'version';
    let finished = false;
    let lastProgress = performance.now();
    let lastHeadersRequest = lastProgress;
    let locatorStart: string | undefined;
    let awaitingHeaders = false;
    let headersSynced = false;
    const inFlight = new Map<string, number>();
    const timer = setInterval(() => {
      try { checkDeadlines(); } catch (error) { finish(error); }
    }, Math.min(1000, timeout));

    function finish(error?: unknown) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve();
    }

    function send(command: string, payload?: Buffer) {
      // Bound pending writes even when a peer floods us with requests without reading replies.
      if (socket.writableLength > 4_000_000) throw new Error('Peer is not reading responses');
      socket.write(frame(magic, command, payload));
    }

    function requestHeaders(from = chain.bestHeader().hash) {
      if (awaitingHeaders) return;
      send('getheaders', getHeaders(chain.locator(from)));
      locatorStart = from;
      awaitingHeaders = true;
      headersSynced = false;
      lastHeadersRequest = performance.now();
    }

    function scheduleBlocks() {
      if (chain.tip().tip === target) return finish();
      if (inFlight.size >= 16) return;
      const wanted = chain.missingBlocks(16, target).filter(hash => !inFlight.has(hash)).slice(0, 16 - inFlight.size);
      if (wanted.length) {
        const now = performance.now();
        for (const hash of wanted) inFlight.set(hash, now);
        send('getdata', getBlocks(wanted));
      } else if (headersSynced && !awaitingHeaders && !inFlight.size && !target && !options.follow) {
        finish();
      }
    }

    function checkDeadlines() {
      const now = performance.now();
      if (handshake !== 'ready') {
        if (now - lastProgress >= timeout) throw new Error('Timed out completing peer handshake');
        return;
      }
      if (awaitingHeaders && now - lastHeadersRequest >= timeout) throw new Error('Timed out waiting for headers');
      for (const start of inFlight.values()) {
        if (now - start >= timeout) throw new Error('Timed out waiting for a requested block');
      }
      if (target && now - lastProgress >= timeout) throw new Error('Peer made no synchronization progress');
      if ((target || options.follow) && !awaitingHeaders && now - lastHeadersRequest >= 10_000) requestHeaders();
    }

    function receive(command: string, payload: Buffer) {
      // We advertise 70016. The feature negotiation message was introduced in 70017.
      if (command === 'feature') throw new Error('Unsupported feature negotiation');
      if (handshake === 'ready' && (command === 'wtxidrelay' || command === 'sendaddrv2')) {
        throw new Error('Late peer negotiation message: ' + command);
      }
      if (command === 'version') {
        if (handshake !== 'version') throw new Error('Duplicate peer version');
        checkVersion(payload, version.nonce);
        send('sendheaders');
        send('verack');
        handshake = 'verack';
        return;
      }
      if (command === 'verack') {
        if (handshake !== 'verack') throw new Error('Unexpected peer verack');
        handshake = 'ready';
        lastProgress = performance.now();
        requestHeaders();
        return;
      }
      if (handshake !== 'ready') return;
      switch (command) {
        case 'ping':
          if (payload.length === 8) send('pong', payload);
          break;
        case 'getheaders': {
          const { locator, stop } = readLocator(payload);
          const headers = chain.answerHeaders(locator, stop);
          if (headers) send('headers', writeHeaders(headers));
          break;
        }
        case 'inv':
          if (blockInventory(payload).some(hash => !chain.hasHeader(hash))) requestHeaders();
          break;
        case 'notfound':
          if (blockInventory(payload).some(hash => inFlight.has(hash))) throw new Error('Peer cannot serve a requested block');
          break;
        case 'headers': {
          const headers = readHeaders(payload);
          const before = chain.bestHeader().hash;
          const result = store.headers(headers, Math.floor(Date.now() / 1000));
          if (result.result !== 'accepted') throw new Error('Peer sent rejected headers: ' + (result.reason ?? result.result));
          if (chain.bestHeader().hash !== before) lastProgress = performance.now();
          awaitingHeaders = false;
          headersSynced = headers.length < 2000;
          if (!headersSynced) {
            const last = displayHash(hash256(headers[headers.length - 1]));
            if (last === locatorStart) throw new Error('Peer repeated a full headers batch');
            requestHeaders(last);
          }
          scheduleBlocks();
          break;
        }
        case 'block': {
          if (payload.length < 80) throw new Error('Peer sent a truncated block');
          const hash = displayHash(hash256(payload.subarray(0, 80)));
          const requested = inFlight.delete(hash);
          const before = chain.tip().tip;
          const result = store.block(payload, Math.floor(Date.now() / 1000), requested);
          if (result.result !== 'accepted' && result.result !== 'duplicate') {
            throw new Error('Peer block ' + hash + ' rejected: ' + (result.reason ?? result.result));
          }
          if (before !== result.tip) {
            lastProgress = performance.now();
            options.onTip?.(result.tip, result.height);
          }
          scheduleBlocks();
          break;
        }
      }
    }

    socket.once('connect', () => {
      try { send('version', version.bytes); } catch (error) { finish(error); }
    });
    socket.on('error', finish);
    socket.once('close', () => finish(new Error('Peer closed the connection')));
    socket.on('data', chunk => {
      try {
        for (const { command, payload } of frames.push(chunk)) {
          receive(command, payload);
          if (finished) break;
        }
      } catch (error) { finish(error); }
    });
  });
}
