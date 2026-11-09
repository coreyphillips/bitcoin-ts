import { Resolver } from 'node:dns/promises';
import { DownloadCoordinator } from './download.js';
import { canonicalPeer, PeerConnectionError, startPeer, type PeerSession, type SyncOptions } from './peer.js';
import { discoverPeers, publicPeerAddress, requireSeedHosts } from './seeds.js';
import type { ChainStore } from './storage.js';

export const DEFAULT_MAX_PEERS = 8;
export const MAX_PEERS = 16;

export interface PoolOptions extends SyncOptions {
  /** Supplying endpoints replaces DNS discovery and the public peer cache. */
  addresses?: readonly string[];
  maxPeers?: number;
  onPeer?: (address: string, state: 'connecting' | 'ready' | 'failed', reason?: string) => void;
  onRetry?: (delayMs: number, reason: string) => void;
}

interface Connection {
  session: PeerSession;
  headersComplete: boolean;
  announced?: string;
  retired?: PeerConnectionError;
}

/** Maintain outbound connections and feed their validated headers and blocks to one chain. */
export async function runPool(store: ChainStore, options: PoolOptions = {}, reconnect = options.follow): Promise<void> {
  const { chain } = store;
  const limit = options.maxPeers ?? DEFAULT_MAX_PEERS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PEERS) throw new RangeError(`maxPeers must be between 1 and ${MAX_PEERS}`);
  const timeout = options.timeout ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RangeError('Invalid synchronization timeout');
  const target = options.stopAt?.toLowerCase();
  if (target !== undefined && !/^[0-9a-f]{64}$/.test(target)) throw new Error('Invalid target block hash');
  options.signal?.throwIfAborted();
  const explicit = options.addresses && [...new Set(options.addresses.map(a => canonicalPeer(a, chain.params.port)))];
  if (explicit?.length === 0) throw new Error('Supply at least one peer');
  const seeds = explicit ? [] : requireSeedHosts(chain.params);
  if (target === chain.tip().tip) return;

  const download = new DownloadCoordinator(store, { stopAt: target, onTip: options.onTip });
  const connections = new Map<string, Connection>();
  const capacity = explicit ? Math.min(limit, explicit.length) : limit;
  const attempted = new Set<string>();
  let pending: string[] = [];
  let lookup: Promise<void> | undefined;
  let resolver: Resolver | undefined;
  let lookedUp = false;
  let retryAt = 0;
  let retryDelay = 2_000;
  let lastFailure = new PeerConnectionError('No reachable peers were found');
  let lastTip = chain.tip().tip;
  let lastHeader = chain.bestHeader().hash;
  let lastProgress = performance.now();

  // Events from all sockets are serialized by the event loop. Coalesce notifications so a
  // hot peer cannot accumulate promises or refill the pool recursively from inside a callback.
  let changed = true;
  let resume: (() => void) | undefined;
  let stopping = false;
  let fatal: { error: unknown } | undefined;
  function wake() { changed = true; resume?.(); }
  function stop(...reason: [] | [unknown]) {
    if (stopping) return;
    stopping = true;
    if (reason.length) fatal = { error: reason[0] };
    for (const { session } of connections.values()) session.close();
    resolver?.cancel();
    wake();
  }
  const abort = () => stop(options.signal?.reason);

  function enqueue(addresses: readonly string[]) {
    const queued = new Set(pending);
    for (const raw of addresses) {
      const address = explicit ? raw : publicPeerAddress(raw);
      if (address && !connections.has(address) && !attempted.has(address) && !queued.has(address)) {
        queued.add(address);
        pending.push(address);
      }
    }
  }
  function beginRound() {
    attempted.clear();
    lookedUp = false;
    retryAt = 0;
    enqueue(explicit ?? store.knownPeers());
  }
  function lookupSeeds() {
    lookedUp = true;
    const deadline = Math.min(timeout, 5_000);
    resolver = new Resolver({ timeout: Math.min(deadline, 3000), tries: 1 });
    lookup = discoverPeers(seeds, deadline, resolver).then(addresses => {
      if (!stopping) enqueue(addresses.slice(0, 32));
    }).catch(error => stop(error)).finally(() => {
      lookup = undefined;
      resolver = undefined;
      wake();
    });
  }
  function progress() {
    const tip = chain.tip().tip;
    const header = chain.bestHeader().hash;
    if (tip !== lastTip || header !== lastHeader) {
      lastProgress = performance.now();
      lastTip = tip;
      lastHeader = header;
    }
    // Close sockets before parsing another block from the same TCP chunk.
    if (target === tip) stop();
    else wake();
  }

  function disconnected(address: string, conn: Connection, error: unknown) {
    connections.delete(address);
    download.remove(address);
    if (!stopping) {
      const failure = conn.retired ?? error;
      if (!(failure instanceof PeerConnectionError)) return stop(failure);
      lastFailure = failure;
      if (!explicit) store.forgetPeer(address);
      options.onPeer?.(address, 'failed', failure.message);
    }
    wake();
  }
  function connect(address: string) {
    attempted.add(address);
    options.onPeer?.(address, 'connecting');
    if (stopping) return;
    const session = startPeer(store, address, {
      timeout, stopAt: target, follow: options.follow,
      requireFullNode: options.requireFullNode ?? !explicit,
    }, {
      onReady() {
        retryDelay = 2_000;
        download.ready(address, session.requestBlocks.bind(session), session.forgetBlock.bind(session));
        if (!explicit) store.rememberPeer(address);
        options.onReady?.();
        options.onPeer?.(address, 'ready');
        wake();
      },
      onHeaders(tip, complete) {
        const conn = connections.get(address)!;
        conn.headersComplete = complete;
        conn.announced = tip;
        download.headers(address, tip);
        progress();
      },
      onBlock(hash, bytes) {
        download.block(address, hash, bytes);
        progress();
      },
    });
    const conn: Connection = { session, headersComplete: false };
    connections.set(address, conn);
    session.done.then(
      () => disconnected(address, conn, undefined),
      error => disconnected(address, conn, error),
    ).catch(error => stop(error));
  }

  // Per-session timers handle handshakes and requests. A pool-wide timer also catches peers
  // that keep answering headers but cannot supply a target or an already known missing branch.
  const tick = setInterval(() => {
    try { store.flushBlocks?.(); wake(); } catch (error) { stop(error); }
  }, Math.min(1000, timeout));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    beginRound();
    while (!stopping) {
      changed = false;
      const now = performance.now();
      if (retryAt && now >= retryAt) beginRound();
      while (!stopping && connections.size < capacity && pending.length) {
        if (!connections.size) lastProgress = now;
        connect(pending.shift()!);
      }
      if (stopping) break;
      const vacancy = connections.size < capacity;
      if (!explicit && vacancy && !lookedUp && !lookup && !retryAt) lookupSeeds();
      download.pump();

      const live = [...connections.values()];
      const allResponded = live.length > 0 && live.every(conn => conn.headersComplete && !conn.retired);
      const caughtUp = allResponded && chain.hasBestWork();
      if (download.reachedTarget() || (!options.follow && !target && caughtUp && !lookup)) break;
      if (allResponded && (target || !caughtUp) && !download.hasPending() && now - lastProgress >= timeout) {
        const stalled = new PeerConnectionError('Peers have no blocks available to advance synchronization');
        if (!reconnect && !pending.length && !lookup && (explicit || lookedUp)) throw stalled;
        // Leave slow outstanding block requests to their own per-peer deadlines. When no peer
        // can serve the next block, open one slot for another candidate, keeping the rest alive.
        if (!vacancy && (pending.length || !explicit)) {
          const replace = live.find(conn => conn.announced !== lastHeader) ?? live[0];
          replace.retired = stalled;
          replace.session.close();
        }
        lastProgress = now;
      }
      if (vacancy && !pending.length && !lookup && !retryAt) {
        if (reconnect) {
          if (!connections.size) options.onRetry?.(retryDelay, lastFailure.message);
          retryAt = now + retryDelay;
          retryDelay = Math.min(retryDelay * 2, 60_000);
        } else if (connections.size === 0) {
          throw lastFailure;
        }
      }
      if (!changed && !stopping) await new Promise<void>(resolve => { resume = resolve; });
      resume = undefined;
    }
  } finally {
    clearInterval(tick);
    options.signal?.removeEventListener('abort', abort);
    stop();
    try {
      store.flushBlocks?.();
    } finally {
      await Promise.allSettled([...connections.values()].map(({ session }) => session.done));
      await lookup;
    }
  }
  if (fatal) throw fatal.error;
}

export function syncPeers(store: ChainStore, addresses: readonly string[], options: Omit<PoolOptions, 'addresses'> = {}) {
  return runPool(store, { ...options, addresses });
}
