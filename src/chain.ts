import { checkBlock, checkBlockContext, parseBlock, type Block } from './block.js';
import { applyChanges, connectBlock, utxoFingerprint } from './coins.js';
import { MemoryBackend, type ChainBackend, type ChainRecord } from './chain-backend.js';
import { networkParams, type NetworkOptions } from './params.js';
import { BlockFailure, blockProof, checkHeaderContext, parseHeader, validProof, type Header } from './pow.js';

interface Entry {
  header: Header;
  parent?: Entry;
  skip?: Entry;
  height: number;
  work: bigint;
  mtp: number;
  bodyOrder: number;
  linked: number;
  failed: boolean;
  connected: boolean;
  children: Entry[];
}

function isBetter(a: Entry, b: Entry) {
  return a.work > b.work || (a.work === b.work && a.linked < b.linked);
}

function compareHash(left: string, right: string): number {
  return Buffer.from(left, 'hex').reverse().compare(Buffer.from(right, 'hex').reverse());
}

type Origin = 'p2p' | 'rpc';
interface Verdict {
  result: 'accepted' | 'duplicate' | 'invalid' | 'orphan' | 'mutated' | 'temporary';
  reason?: string;
}

const bip34Hashes: Record<string, string> = {
  main: '000000000000024b89b42a942fe0d9fea3bb44ab7bd1b19115dd6a759c0808b8',
  testnet3: '0000000023b3a96d3484e5abb3755c413e7d41500f8e2a5c3f0dd01299cd8ef8',
};

/** Validates and selects the active chain. Full bodies, UTXOs and undo use the selected backend. */
export class Chain {
  readonly params;
  private readonly entries = new Map<string, Entry>();
  private readonly active: Entry[];
  private readonly candidates = new Set<Entry>();
  private readonly waiting = new Map<Entry, Entry[]>();
  private readonly backend: ChainBackend;
  private arrival = 1;
  private highest: Entry;
  private sequence = 1;

  constructor(network: string, options: NetworkOptions = {}, backend: ChainBackend = new MemoryBackend()) {
    this.backend = backend;
    this.params = networkParams(network, options);
    const header = parseHeader(this.params.genesis);
    const genesis: Entry = {
      header, height: 0, work: blockProof(header.bits), mtp: header.time, linked: 1, bodyOrder: 1, failed: false, connected: true, children: [],
    };
    this.active = [genesis];
    this.entries.set(header.hash, genesis);
    this.candidates.add(genesis);
    this.highest = genesis;
    const tip = backend.activeTip();
    if (tip === undefined) {
      if (backend.bestHeader() !== undefined || !backend.records()[Symbol.iterator]().next().done) {
        throw new Error('Incomplete chain metadata');
      }
      this.save(genesis);
      backend.setActiveTip(header.hash);
      backend.setBestHeader(header.hash);
    } else {
      this.restore(tip);
    }
  }

  private save(entry: Entry): void {
    this.backend.saveRecord({
      hash: entry.header.hash, header: entry.header.raw, linked: entry.linked,
      failed: entry.failed, connected: entry.connected, bodyOrder: entry.bodyOrder,
    });
  }

  private restore(tip: string): void {
    const waiting: Entry[] = [];
    let foundGenesis = false;
    for (const record of this.backend.records()) {
      const header = parseHeader(record.header);
      if (header.hash !== record.hash) throw new Error('Stored block header hash mismatch');
      if (!foundGenesis) {
        if (record.hash !== this.head.header.hash || record.failed || !record.connected || !record.linked || !record.bodyOrder) {
          throw new Error('Invalid genesis record');
        }
        foundGenesis = true;
        continue;
      }
      const parent = this.entries.get(header.previous);
      if (!parent) throw new Error('Missing parent of stored header');
      const entry = this.indexHeader(header, parent, record);
      if (entry.bodyOrder && !entry.failed && !entry.linked) waiting.push(entry);
      this.sequence = Math.max(this.sequence, entry.linked);
      this.arrival = Math.max(this.arrival, entry.bodyOrder);
    }
    const active = this.entries.get(tip);
    const best = this.entries.get(this.backend.bestHeader() ?? '');
    if (!foundGenesis || !active || !best || best.failed) throw new Error('Missing stored chain tip');
    this.highest = best;
    for (let node: Entry | undefined = active; node?.parent; node = node.parent) {
      if (node.failed || !node.linked || !node.connected || !node.bodyOrder) throw new Error('Invalid stored active chain');
      this.active[node.height] = node;
    }
    // Full data can arrive before its parent's data. Restore its original queue order.
    for (const entry of waiting.sort((a, b) => a.bodyOrder - b.bodyOrder)) this.waitForParent(entry);
    this.candidates.clear();
    for (const entry of this.entries.values()) {
      if (!entry.failed && entry.linked && !isBetter(active, entry)) this.candidates.add(entry);
    }
    this.activate();
  }

  private get head(): Entry { return this.active[this.active.length - 1]; }

  tip() {
    const entry = this.head;
    return { tip: entry.header.hash, height: entry.height, chainwork: entry.work.toString(16).padStart(64, '0') };
  }

  hasHeader(hash: string): boolean { return this.entries.has(hash); }
  bestHeader() { return { hash: this.highest.header.hash, height: this.highest.height }; }
  utxoHash() { return utxoFingerprint(this.backend.coins); }

  private isActive(entry: Entry): boolean { return this.active[entry.height] === entry; }
  private ancestor(entry: Entry, height: number): Entry {
    if (height < 0 || height > entry.height) throw new RangeError('invalid ancestor height');
    while (entry.height > height) {
      if (this.isActive(entry)) return this.active[height];
      entry = entry.skip && entry.skip.height >= height ? entry.skip : entry.parent!;
    }
    return entry;
  }

  isAncestor(hash: string, descendant: string): boolean {
    const a = this.entries.get(hash);
    const b = this.entries.get(descendant);
    return !!a && !!b && a.height <= b.height && this.ancestor(b, a.height) === a;
  }

  /** Select the most-work validated header a connected peer says it can serve. */
  bestOfferedHeader(hashes: Iterable<string>): string | undefined {
    let best: Entry | undefined;
    for (const hash of hashes) {
      const entry = this.entries.get(hash);
      if (!entry || entry.failed || entry.work <= this.head.work) continue;
      if (!best || entry.work > best.work || (entry.work === best.work && entry === this.highest)) best = entry;
    }
    return best?.header.hash;
  }

  hasBestWork(): boolean { return this.head.work >= this.highest.work; }

  locator(fromHash?: string): string[] {
    const hashes: string[] = [];
    let entry = fromHash === undefined ? this.head : this.entries.get(fromHash);
    if (!entry) throw new Error('unknown locator start hash');
    let step = 1;
    for (;;) {
      hashes.push(entry.header.hash);
      if (!entry.height) return hashes;
      entry = this.ancestor(entry, Math.max(0, entry.height - step));
      if (hashes.length > 10) step *= 2;
    }
  }

  answerHeaders(locator: string[], stop: string): Buffer[] | null {
    if (!locator.length) {
      const entry = this.entries.get(stop);
      return entry && this.isActive(entry) ? [Buffer.from(entry.header.raw)] : null;
    }
    let start = 0;
    for (const hash of locator) {
      const entry = this.entries.get(hash);
      if (!entry) continue;
      if (this.isActive(entry)) { start = entry.height; break; }
      if (entry.height > this.head.height && this.ancestor(entry, this.head.height) === this.head) return [];
    }
    const headers: Buffer[] = [];
    for (let i = start + 1; i < this.active.length && headers.length < 2000; i++) {
      const header = this.active[i].header;
      headers.push(Buffer.from(header.raw));
      if (header.hash === stop) break;
    }
    return headers;
  }

  missingBlocks(limit = Infinity, stopHash?: string, branchHash = this.highest.header.hash, window = Infinity): string[] {
    if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('invalid block request limit');
    if (window !== Infinity && (!Number.isSafeInteger(window) || window < 1)) throw new RangeError('invalid block window');
    let entry = this.entries.get(branchHash);
    if (!entry || entry.failed) return [];
    const stop = stopHash ? this.entries.get(stopHash) : undefined;
    if (stop && stop.height <= entry.height && this.ancestor(entry, stop.height) === stop) entry = stop;
    if (entry.linked || !limit) return [];

    // Linked entries have every body back to genesis. Locate the first gap on this branch,
    // including during a reorg where earlier fork bodies have already arrived.
    let low = Math.min(this.head.height, entry.height);
    if (!this.ancestor(entry, low).linked) low = 0;
    if (this.ancestor(entry, low + 1).linked) {
      let high = entry.height - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (this.ancestor(entry, mid).linked) low = mid;
        else high = mid - 1;
      }
    }
    const last = Math.min(entry.height, low + window);
    const missing: string[] = [];
    for (let start = low + 1; start <= last && missing.length < limit;) {
      const end = Math.min(last, start + Math.min(2048, limit - missing.length) - 1);
      let cursor = this.ancestor(entry, end);
      const batch: string[] = [];
      while (cursor.height >= start) {
        if (!cursor.bodyOrder) batch.push(cursor.header.hash);
        cursor = cursor.parent!;
      }
      missing.push(...batch.reverse());
      start = end + 1;
    }
    return missing;
  }

  private threshold(): bigint {
    const threshold = this.head.work - 144n * blockProof(this.head.header.bits);
    return threshold > 0n ? threshold : 0n;
  }

  private headersAcceptable(headers: Header[]): boolean {
    if (!headers.length) return true;
    const parent = this.entries.get(headers[0].previous);
    if (headers.length > 2000 || !parent) return false;
    let previous = parent.header.hash;
    let work = parent.work;
    for (const header of headers) {
      if (previous !== header.previous || !validProof(header, this.params.powLimit)) return false;
      work += blockProof(header.bits);
      previous = header.hash;
    }
    if (work >= this.threshold()) return true;
    const last = this.entries.get(previous);
    return !!last && (this.isActive(last) || (this.highest.height >= last.height && this.ancestor(this.highest, last.height) === last));
  }

  private acceptHeader(header: Header, now: number, lowWork = false): Entry {
    const known = this.entries.get(header.hash);
    if (known) {
      if (known.failed) throw new BlockFailure('invalid', 'duplicate-invalid');
      return known;
    }
    if (!validProof(header, this.params.powLimit)) throw new BlockFailure('invalid', 'high-hash');
    const parent = this.entries.get(header.previous);
    if (!parent) throw new BlockFailure('orphan', 'prev-blk-not-found');
    if (parent.failed) throw new BlockFailure('invalid', 'bad-prevblk');
    checkHeaderContext(header, parent, this.params, now, height => this.ancestor(parent, height));
    const work = parent.work + blockProof(header.bits);
    if (lowWork && work < this.threshold()) throw new BlockFailure('invalid', 'too-little-chainwork');
    const entry = this.indexHeader(header, parent);
    this.save(entry);
    if (work > this.highest.work) {
      this.highest = entry;
      this.backend.setBestHeader(header.hash);
    }
    return entry;
  }

  private indexHeader(header: Header, parent: Entry, record?: ChainRecord): Entry {
    const times = [header.time];
    for (let p: Entry | undefined = parent; p && times.length < 11; p = p.parent) times.push(p.header.time);
    times.sort((a, b) => a - b);
    const height = parent.height + 1;
    const entry: Entry = {
      header, parent, skip: this.ancestor(parent, height & (height - 1)), height,
      work: parent.work + blockProof(header.bits), mtp: times[times.length >> 1],
      bodyOrder: record?.bodyOrder ?? 0, linked: record?.linked ?? 0, failed: record?.failed ?? false,
      connected: record?.connected ?? false, children: [],
    };
    parent.children.push(entry);
    this.entries.set(header.hash, entry);
    return entry;
  }

  processHeaders(raw: Buffer[], now: number, via: Origin = 'p2p') {
    const headers = raw.map(bytes => parseHeader(Buffer.from(bytes)));
    if (via === 'p2p' && !this.headersAcceptable(headers)) {
      return { result: 'invalid', reason: 'headers-message-rejected', best_header: this.highest.header.hash };
    }
    for (let index = 0; index < headers.length; index++) {
      try { this.acceptHeader(headers[index], now); }
      catch (error) {
        if (!(error instanceof BlockFailure)) throw error;
        return { result: error.result, reason: error.message, index, best_header: this.highest.header.hash };
      }
    }
    return { result: 'accepted', best_header: this.highest.header.hash };
  }

  processBlock(bytes: Buffer, now: number, via: Origin = 'p2p', requested = true) {
    const raw = Buffer.from(bytes);
    let block: Block;
    try { block = parseBlock(raw); }
    catch (error) {
      return { result: 'mutated', reason: error instanceof Error ? error.message : 'block-decode', height: this.head.height, tip: this.head.header.hash };
    }
    let verdict: Verdict;
    try { verdict = this.receiveBlock(block, raw.subarray(0, block.total), now, via, requested); }
    catch (error) {
      if (!(error instanceof BlockFailure)) throw error;
      verdict = { result: error.result, reason: error.message };
    }
    return { ...verdict, height: this.head.height, tip: this.head.header.hash };
  }

  private receiveBlock(block: Block, raw: Buffer, now: number, via: Origin, requested: boolean): Verdict {
    const parent = this.entries.get(block.header.previous);
    const peerSegwit = via === 'p2p' && parent ? parent.height + 1 >= this.params.heights.segwit : undefined;
    checkBlock(block, this.params, this.active[0].header.hash, peerSegwit);
    const entry = this.acceptHeader(block.header, now, via === 'p2p');
    if (entry.bodyOrder) {
      this.activate();
      return { result: 'duplicate' };
    }
    if (via === 'p2p' && !requested && (entry.work < this.head.work || entry.height > this.head.height + 288)) {
      this.activate();
      return { result: 'accepted', reason: 'unrequested-header-only' };
    }
    try { checkBlockContext(block, entry.height, entry.parent!.mtp, this.params); }
    catch (error) {
      if (error instanceof BlockFailure && error.result === 'invalid') this.markInvalid(entry);
      throw error;
    }
    this.backend.putBlock(entry.header.hash, raw);
    entry.bodyOrder = ++this.arrival;
    this.link(entry);
    const failure = this.activate(block).get(entry);
    if (failure) throw failure;
    return { result: 'accepted' };
  }

  private waitForParent(entry: Entry): void {
    const parent = entry.parent!;
    const list = this.waiting.get(parent) ?? [];
    list.push(entry);
    this.waiting.set(parent, list);
  }

  private link(entry: Entry): void {
    if (!entry.parent!.linked) {
      this.waitForParent(entry);
      this.save(entry);
      return;
    }
    const queue = [entry];
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i];
      if (next.failed) continue;
      next.linked = ++this.sequence;
      this.save(next);
      if (isBetter(next, this.head)) this.candidates.add(next);
      const children = this.waiting.get(next);
      if (children) {
        for (const child of children) queue.push(child);
        this.waiting.delete(next);
      }
    }
  }

  private markInvalid(entry: Entry): void {
    const stack = [entry];
    while (stack.length) {
      const next = stack.pop()!;
      next.failed = true;
      this.save(next);
      this.candidates.delete(next);
      this.waiting.delete(next);
      for (const child of next.children) stack.push(child);
    }
    if (this.highest.failed) {
      this.highest = this.head;
      for (const next of this.entries.values()) {
        if (!next.failed && next.work > this.highest.work) this.highest = next;
      }
      this.backend.setBestHeader(this.highest.header.hash);
    }
  }

  private disconnect(): void {
    const entry = this.active.pop()!;
    applyChanges(this.backend.coins, this.backend.getUndo(entry.header.hash));
    this.backend.setActiveTip(this.head.header.hash);
  }

  private activate(recent?: Block): Map<Entry, BlockFailure> {
    const failures = new Map<Entry, BlockFailure>();
    for (;;) {
      let best = this.head;
      for (const entry of this.candidates) if (isBetter(entry, best)) best = entry;
      if (best === this.head) return failures;
      const path: Entry[] = [];
      let fork = best;
      while (!this.isActive(fork)) { path.push(fork); fork = fork.parent!; }
      while (this.head !== fork) this.disconnect();
      for (let index = path.length - 1; index >= 0; index--) {
        const entry = path[index];
        const bip34 = this.active[this.params.heights.bip34];
        const onBip34Chain = !!bip34 && bip34.header.hash === bip34Hashes[this.params.network];
        try {
          const hash = entry.header.hash;
          const block = recent?.header.hash === hash ? recent : parseBlock(this.backend.getBlock(hash));
          if (block.header.hash !== hash) throw new Error('Stored block hash mismatch');
          const undo = connectBlock(block, entry.height, this.head.mtp, h => this.active[h].mtp, this.backend.coins, this.params, onBip34Chain);
          this.backend.putUndo(hash, undo);
        } catch (error) {
          if (!(error instanceof BlockFailure)) throw error;
          failures.set(entry, error);
          this.markInvalid(entry);
          break;
        }
        if (!entry.connected) {
          entry.connected = true;
          this.save(entry);
        }
        this.active.push(entry);
        this.backend.setActiveTip(entry.header.hash);
        for (const candidate of this.candidates) if (isBetter(entry, candidate)) this.candidates.delete(candidate);
      }
    }
  }

  invalidate(hash: string) {
    const entry = this.entries.get(hash);
    if (entry && entry.height) {
      while (this.isActive(entry)) this.disconnect();
      this.markInvalid(entry);
      for (const candidate of this.entries.values()) {
        if (candidate.linked && !candidate.failed && !isBetter(this.head, candidate)) this.candidates.add(candidate);
      }
      this.activate();
    }
    return { tip: this.head.header.hash, height: this.head.height };
  }

  tips() {
    const tips = [];
    for (const entry of this.entries.values()) {
      if (entry !== this.head && (this.isActive(entry) || entry.children.length)) continue;
      const status = entry === this.head ? 'active' : entry.failed ? 'invalid' : !entry.linked ? 'headers-only' : entry.connected ? 'valid-fork' : 'valid-headers';
      tips.push({ height: entry.height, hash: entry.header.hash, status });
    }
    tips.sort((a, b) => b.height - a.height || compareHash(a.hash, b.hash));
    return { tips };
  }
}
