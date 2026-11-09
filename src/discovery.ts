import { setTimeout as sleep } from 'node:timers/promises';
import { PeerConnectionError, syncPeer, type SyncOptions } from './peer.js';
import { discoverPeers, publicPeerAddress, requireSeedHosts } from './seeds.js';
import type { ChainStore } from './storage.js';

export interface DiscoveryOptions extends Pick<SyncOptions, 'stopAt' | 'follow' | 'timeout' | 'onTip'> {
  /** Connection progress, including an error message if a peer fails. */
  onPeer?: (address: string, state: 'connecting' | 'ready' | 'failed', reason?: string) => void;
  /** Follow mode exhausted its peer candidates and will try discovery again. */
  onRetry?: (delayMs: number, reason: string) => void;
}

/** Start with remembered peers, then use DNS seeds and switch peers on connection failure. */
export async function syncNetwork(store: ChainStore, options: DiscoveryOptions = {}): Promise<void> {
  const seeds = requireSeedHosts(store.chain.params);
  if (options.stopAt?.toLowerCase() === store.chain.tip().tip) return;
  const timeout = options.timeout ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid synchronization timeout');
  let retryDelay = 2_000;

  for (;;) {
    const attempted = new Set<string>();
    let lastFailure = 'DNS seeds returned no reachable public addresses';
    async function tryAddresses(addresses: string[]): Promise<boolean> {
      for (const raw of addresses) {
        const address = publicPeerAddress(raw);
        if (!address || attempted.has(address)) continue;
        attempted.add(address);
        options.onPeer?.(address, 'connecting');
        try {
          await syncPeer(store, address, {
            timeout, follow: options.follow, stopAt: options.stopAt, onTip: options.onTip, requireFullNode: true,
            onReady() {
              store.rememberPeer(address);
              options.onPeer?.(address, 'ready');
              retryDelay = 2_000;
            },
          });
          return true;
        } catch (error) {
          if (!(error instanceof PeerConnectionError)) throw error;
          lastFailure = error.message;
          store.forgetPeer(address);
          options.onPeer?.(address, 'failed', error.message);
        }
      }
      return false;
    }

    // A working cached peer allows a restart even if DNS is down.
    if (await tryAddresses(store.knownPeers())) return;
    const addresses = await discoverPeers(seeds, Math.min(timeout, 5_000));
    if (await tryAddresses(addresses.slice(0, 24))) return;
    if (!options.follow) {
      throw new Error(`Could not synchronize with a discovered peer (${attempted.size} tried). ${lastFailure}`);
    }
    options.onRetry?.(retryDelay, lastFailure);
    await sleep(retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60_000);
  }
}
