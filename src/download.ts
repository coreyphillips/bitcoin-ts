import type { SyncOptions } from './peer.js';
import type { ChainStore } from './storage.js';
import { PeerConnectionError } from './wire.js';

interface Source {
  tip?: string;
  window: number;
  pending: Set<string>;
  request: (hashes: string[]) => void;
  forget: (hash: string) => void;
}

/** One owner per requested body across all sockets. All updates run on the Node event loop. */
export class DownloadCoordinator {
  private readonly sources = new Map<string, Source>();
  private readonly owners = new Map<string, Source>();
  private assignedBranch?: string;
  private offersChanged = false;
  private readonly store: ChainStore;
  private readonly options: Pick<SyncOptions, 'stopAt' | 'onTip'>;
  private readonly target?: string;

  constructor(store: ChainStore, options: Pick<SyncOptions, 'stopAt' | 'onTip'>) {
    this.store = store;
    this.options = options;
    this.target = options.stopAt?.toLowerCase();
  }

  ready(address: string, request: Source['request'], forget: Source['forget']) {
    this.sources.set(address, { request, forget, pending: new Set(), window: 1 });
  }

  headers(address: string, tip: string | undefined) {
    const peer = this.sources.get(address);
    if (!peer) return;
    if (tip !== undefined && tip !== peer.tip) {
      peer.tip = tip;
      this.offersChanged = true;
    }
  }

  private release(hash: string, owner: Source) {
    this.owners.delete(hash);
    owner.pending.delete(hash);
    owner.forget(hash);
  }

  remove(address: string) {
    const peer = this.sources.get(address);
    if (!peer) return;
    for (const hash of peer.pending) this.release(hash, peer);
    this.sources.delete(address);
  }

  hasPending() { return this.owners.size > 0; }

  reachedTarget() {
    return this.target !== undefined && this.store.chain.tip().tip === this.target;
  }

  block(address: string, hash: string, bytes: Buffer) {
    const source = this.sources.get(address);
    if (!source) return;
    const owner = this.owners.get(hash);
    const before = this.store.chain.tip().tip;
    const write = this.store.downloadBlock ?? this.store.block;
    const result = write.call(this.store, bytes, Math.floor(Date.now() / 1000), owner === source);
    if (result.result !== 'accepted' && result.result !== 'duplicate') {
      // A bad unsolicited copy must leave the original peer's request alive.
      throw new PeerConnectionError(`Peer block ${hash} rejected: ${result.reason ?? result.result}`);
    }
    if (result.reason === 'unrequested-header-only') return;
    if (owner) this.release(hash, owner);
    if (owner === source) source.window = Math.min(16, source.window + 1);
    if (before !== result.tip) this.options.onTip?.(result.tip, result.height);
  }

  pump() {
    const { chain } = this.store;
    const peers = [...this.sources.values()].filter(peer => peer.tip !== undefined);
    const branch = chain.bestOfferedHeader(peers.map(peer => peer.tip!));
    // A new best branch or a peer announcing a different chain can invalidate old assignments.
    if (branch !== this.assignedBranch || this.offersChanged) {
      for (const [hash, owner] of this.owners) {
        if (!branch || !chain.isAncestor(hash, branch) || !owner.tip || !chain.isAncestor(hash, owner.tip)) {
          this.release(hash, owner);
        }
      }
      this.assignedBranch = branch;
      this.offersChanged = false;
    }
    if (!branch || this.reachedTarget()) return;

    const capacity = peers.reduce((sum, p) => sum + p.window - p.pending.size, 0);
    if (!capacity) return;
    const batches = new Map<Source, string[]>();
    // Bound out-of-order downloads when an early block is slow. The window starts at the first gap.
    const missing = chain.missingBlocks(this.owners.size + capacity, this.target, branch, 1024);
    for (const hash of missing) {
      if (this.owners.has(hash)) continue;
      let selected: Source | undefined;
      for (const peer of peers) {
        if (peer.pending.size >= peer.window || (selected && selected.pending.size <= peer.pending.size)) continue;
        if (chain.isAncestor(hash, peer.tip!)) selected = peer;
      }
      if (!selected) continue;
      this.owners.set(hash, selected);
      selected.pending.add(hash);
      const batch = batches.get(selected);
      if (batch) batch.push(hash);
      else batches.set(selected, [hash]);
    }
    for (const [peer, hashes] of batches) peer.request(hashes);
  }
}
