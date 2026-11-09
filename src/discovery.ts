import { runPool, type PoolOptions } from './pool.js';
import type { ChainStore } from './storage.js';

export type DiscoveryOptions = Omit<PoolOptions, 'addresses' | 'requireFullNode' | 'onReady'>;

/** Connect to remembered public peers and fill vacant outbound slots from DNS seeds. */
export function syncNetwork(store: ChainStore, options: DiscoveryOptions = {}): Promise<void> {
  return runPool(store, { ...options, addresses: undefined, requireFullNode: true });
}
