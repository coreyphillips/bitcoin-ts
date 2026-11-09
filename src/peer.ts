import { createConnection, isIP, SocketAddress } from 'node:net';
import { hash256 } from './codec.js';
import type { ChainStore } from './storage.js';
import {
  FrameReader, PeerConnectionError, blockInventory, checkVersion, displayHash, frame, getBlocks,
  getHeaders, readHeaders, readLocator, versionMessage, writeHeaders,
} from './wire.js';

export { PeerConnectionError } from './wire.js';

export interface SyncOptions {
  signal?: AbortSignal;
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
  'EAI_AGAIN', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ERR_SOCKET_CLOSED', 'ERR_SOCKET_CONNECTION_TIMEOUT',
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

/** Normalize explicit endpoint names before allocating an outbound slot. */
export function canonicalPeer(address: string, defaultPort: number): string {
  const { host, port } = endpoint(address, defaultPort);
  if (isIP(host) === 6) {
    const [ip, zone] = host.split('%');
    const canonical = new SocketAddress({ address: ip, family: 'ipv6' }).address + (zone ? '%' + zone : '');
    return port === defaultPort ? canonical : `[${canonical}]:${port}`;
  }
  return host.toLowerCase() + (port === defaultPort ? '' : ':' + port);
}

export interface PeerHooks {
  onReady(): void;
  /** Tip advertised by this peer and whether it has finished its current headers batch series. */
  onHeaders(tip: string | undefined, complete: boolean): void;
  onBlock(hash: string, bytes: Buffer): void;
}

export interface PeerSession {
  readonly done: Promise<void>;
  requestBlocks(hashes: string[]): void;
  forgetBlock(hash: string): void;
  close(): void;
}

/** A v1 outbound connection. The pool chooses which blocks to request and owns chain activation. */
export function startPeer(store: ChainStore, address: string, options: SyncOptions, hooks: PeerHooks): PeerSession {
  const { chain } = store;
  const target = options.stopAt?.toLowerCase();
  const timeout = options.timeout ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid synchronization timeout');
  const handshakeTimeout = options.requireFullNode ? Math.min(timeout, 10_000) : timeout;
  const peer = endpoint(address, chain.params.port);
  const magic = chain.params.magic;
  const frames = new FrameReader(magic);
  const version = versionMessage(chain.tip().height);
  const socket = createConnection({ ...peer, noDelay: true });
  let handshake: 'version' | 'verack' | 'ready' = 'version';
  const started = performance.now();
  let finished = false;
  let lastHeadersRequest = started;
  let locatorStart: string | undefined;
  let awaitingHeaders = false;
  let announced: string | undefined;
  const inFlight = new Map<string, number>();
  let resolveDone!: () => void;
  let rejectDone!: (reason: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const timer = setInterval(() => {
    try { checkDeadlines(); } catch (error) { finish(error); }
  }, Math.min(1000, timeout));

  function finish(...failure: [] | [unknown]) {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    socket.destroy();
    if (failure.length) rejectDone(failure[0]);
    else resolveDone();
  }

  function send(command: string, payload?: Buffer) {
    if (socket.writableLength > 4_000_000) throw new PeerConnectionError('Peer is not reading responses');
    socket.write(frame(magic, command, payload));
  }

  function requestHeaders() {
    if (finished || awaitingHeaders) return;
    const from = announced ?? chain.tip().tip;
    // On restart the active tip may precede the local best header. Starting here lets each
    // peer establish the branch for which it can supply missing block bodies.
    send('getheaders', getHeaders(chain.locator(from), target));
    locatorStart = from;
    awaitingHeaders = true;
    lastHeadersRequest = performance.now();
    hooks.onHeaders(announced, false);
  }

  function checkDeadlines() {
    const now = performance.now();
    if (handshake !== 'ready') {
      if (now - started >= handshakeTimeout) throw new PeerConnectionError('Timed out completing peer handshake');
      return;
    }
    if (awaitingHeaders && now - lastHeadersRequest >= timeout) throw new PeerConnectionError('Timed out waiting for headers');
    for (const start of inFlight.values()) {
      if (now - start >= timeout) throw new PeerConnectionError('Timed out waiting for a requested block');
    }
    if ((target || options.follow) && now - lastHeadersRequest >= 10_000) requestHeaders();
  }

  function receive(command: string, payload: Buffer) {
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
      hooks.onReady();
      requestHeaders();
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
        if (decodePayload(() => blockInventory(payload)).some(hash => hash !== announced)) requestHeaders();
        break;
      case 'notfound':
        if (decodePayload(() => blockInventory(payload)).some(hash => inFlight.has(hash))) throw new PeerConnectionError('Peer cannot serve a requested block');
        break;
      case 'headers': {
        const headers = decodePayload(() => readHeaders(payload));
        const result = store.headers(headers, Math.floor(Date.now() / 1000));
        if (result.result !== 'accepted') throw new PeerConnectionError('Peer sent rejected headers: ' + (result.reason ?? result.result));
        awaitingHeaders = false;
        if (headers.length) announced = displayHash(hash256(headers[headers.length - 1]));
        // An empty response does not identify which locator hash matched the remote chain.
        if (headers.length < 2000 || announced === target) {
          hooks.onHeaders(announced, true);
        } else {
          if (announced === locatorStart) throw new PeerConnectionError('Peer repeated a full headers batch');
          requestHeaders();
        }
        break;
      }
      case 'block': {
        if (payload.length < 80) throw new PeerConnectionError('Peer sent a truncated block');
        const hash = displayHash(hash256(payload.subarray(0, 80)));
        inFlight.delete(hash);
        hooks.onBlock(hash, payload);
        break;
      }
    }
  }

  socket.once('connect', () => {
    if (finished) return;
    try { send('version', version.bytes); } catch (error) { finish(error); }
  });
  socket.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code && transportErrors.has(error.code)) finish(new PeerConnectionError(error.message, { cause: error }));
    else finish(error);
  });
  socket.once('close', () => finish(new PeerConnectionError('Peer closed the connection')));
  socket.on('data', chunk => {
    if (finished) return;
    try {
      for (const { command, payload } of frames.push(chunk)) {
        receive(command, payload);
        if (finished) break;
      }
    } catch (error) { finish(error); }
  });

  return {
    done,
    close: () => finish(),
    forgetBlock(hash) { inFlight.delete(hash); },
    requestBlocks(hashes) {
      if (finished || !hashes.length) return;
      if (handshake !== 'ready') throw new Error('Cannot request blocks before peer handshake');
      if (inFlight.size + hashes.length > 16) throw new Error('Too many in-flight blocks for peer');
      const now = performance.now();
      for (const hash of hashes) inFlight.set(hash, now);
      try { send('getdata', getBlocks(hashes)); } catch (error) { finish(error); }
    },
  };
}

/** Sync against one explicit endpoint using the same validation and scheduling path as the pool. */
export async function syncPeer(store: ChainStore, address: string, options: SyncOptions = {}): Promise<void> {
  const { runPool } = await import('./pool.js');
  // The single-peer API reports a disconnect to its caller, including in follow mode.
  await runPool(store, { ...options, addresses: [address], maxPeers: 1 }, false);
}
