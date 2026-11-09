import { createConnection, isIP } from 'node:net';
import { hash256 } from './codec.js';
import type { ChainStore } from './storage.js';
import {
  FrameReader, PeerConnectionError, blockInventory, checkVersion, displayHash, frame, getBlocks,
  getHeaders, readHeaders, readLocator, versionMessage, writeHeaders,
} from './wire.js';

export { PeerConnectionError } from './wire.js';

export interface SyncOptions {
  stopAt?: string;
  follow?: boolean;
  /** Milliseconds allowed for a handshake, request, or a target without progress. */
  timeout?: number;
  /** Restrict automatic downloads to archival nodes that serve witness data. */
  requireFullNode?: boolean;
  onReady?: () => void;
  onTip?: (hash: string, height: number) => void;
}

// Only errors decoding remote message bytes belong to the peer. Storage and caller callbacks
// run outside this boundary so failures there stop automatic synchronization immediately.
function decodePayload<T>(decode: () => T): T {
  try { return decode(); }
  catch (error) {
    throw new PeerConnectionError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

const transportErrors = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTDOWN', 'EHOSTUNREACH',
  'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'ERR_SOCKET_CLOSED', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

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
    // A stale DNS address should give another candidate a turn promptly.
    const handshakeTimeout = options.requireFullNode ? Math.min(timeout, 10_000) : timeout;
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

    function finish(...failure: [] | [unknown]) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      socket.destroy();
      if (failure.length) reject(failure[0]);
      else resolve();
    }

    function send(command: string, payload?: Buffer) {
      // Bound pending writes even when a peer floods us with requests without reading replies.
      if (socket.writableLength > 4_000_000) throw new PeerConnectionError('Peer is not reading responses');
      socket.write(frame(magic, command, payload));
    }

    function requestHeaders(from = chain.bestHeader().hash) {
      if (awaitingHeaders) return;
      send('getheaders', getHeaders(chain.locator(from), target));
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
        if (now - lastProgress >= handshakeTimeout) throw new PeerConnectionError('Timed out completing peer handshake');
        return;
      }
      if (awaitingHeaders && now - lastHeadersRequest >= timeout) throw new PeerConnectionError('Timed out waiting for headers');
      for (const start of inFlight.values()) {
        if (now - start >= timeout) throw new PeerConnectionError('Timed out waiting for a requested block');
      }
      if (target && now - lastProgress >= timeout) throw new PeerConnectionError('Peer made no synchronization progress');
      if ((target || options.follow) && !awaitingHeaders && now - lastHeadersRequest >= 10_000) requestHeaders();
    }

    function receive(command: string, payload: Buffer) {
      // We advertise 70016. The feature negotiation message was introduced in 70017.
      if (command === 'feature') throw new PeerConnectionError('Unsupported feature negotiation');
      if (handshake === 'ready' && (command === 'wtxidrelay' || command === 'sendaddrv2')) {
        throw new PeerConnectionError('Late peer negotiation message: ' + command);
      }
      if (command === 'version') {
        if (handshake !== 'version') throw new PeerConnectionError('Duplicate peer version');
        const services = decodePayload(() => checkVersion(payload, version.nonce));
        const fullNodeServices = 1n | 8n; // NODE_NETWORK and NODE_WITNESS
        if (options.requireFullNode && (services & fullNodeServices) !== fullNodeServices) {
          throw new PeerConnectionError('Peer does not advertise full block and witness service');
        }
        send('sendheaders');
        send('verack');
        handshake = 'verack';
        return;
      }
      if (command === 'verack') {
        if (handshake !== 'verack') throw new PeerConnectionError('Unexpected peer verack');
        handshake = 'ready';
        lastProgress = performance.now();
        options.onReady?.();
        requestHeaders();
        scheduleBlocks();
        return;
      }
      if (handshake !== 'ready') return;
      switch (command) {
        case 'ping':
          if (payload.length === 8) send('pong', payload);
          break;
        case 'getheaders': {
          const { locator, stop } = decodePayload(() => readLocator(payload));
          const headers = chain.answerHeaders(locator, stop);
          if (headers) send('headers', writeHeaders(headers));
          break;
        }
        case 'inv':
          if (decodePayload(() => blockInventory(payload)).some(hash => !chain.hasHeader(hash))) requestHeaders();
          break;
        case 'notfound':
          if (decodePayload(() => blockInventory(payload)).some(hash => inFlight.has(hash))) throw new PeerConnectionError('Peer cannot serve a requested block');
          break;
        case 'headers': {
          const headers = decodePayload(() => readHeaders(payload));
          const before = chain.bestHeader().hash;
          const result = store.headers(headers, Math.floor(Date.now() / 1000));
          if (result.result !== 'accepted') throw new PeerConnectionError('Peer sent rejected headers: ' + (result.reason ?? result.result));
          if (chain.bestHeader().hash !== before) lastProgress = performance.now();
          awaitingHeaders = false;
          const last = headers.length ? displayHash(hash256(headers[headers.length - 1])) : undefined;
          headersSynced = headers.length < 2000 || (target !== undefined && last === target);
          scheduleBlocks();
          if (!headersSynced && last) {
            if (last === locatorStart) throw new PeerConnectionError('Peer repeated a full headers batch');
            requestHeaders(last);
          }
          break;
        }
        case 'block': {
          if (payload.length < 80) throw new PeerConnectionError('Peer sent a truncated block');
          const hash = displayHash(hash256(payload.subarray(0, 80)));
          const requested = inFlight.delete(hash);
          const before = chain.tip().tip;
          const result = store.block(payload, Math.floor(Date.now() / 1000), requested);
          if (result.result !== 'accepted' && result.result !== 'duplicate') {
            throw new PeerConnectionError('Peer block ' + hash + ' rejected: ' + (result.reason ?? result.result));
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
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code && transportErrors.has(error.code)) finish(new PeerConnectionError(error.message, { cause: error }));
      else finish(error);
    });
    socket.once('close', () => finish(new PeerConnectionError('Peer closed the connection')));
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
