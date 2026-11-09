import type { Changes, Coin, CoinView } from './coins.js';

export interface ChainRecord {
  hash: string;
  header: Buffer;
  linked: number;
  failed: boolean;
  connected: boolean;
  /** First full-body arrival order, or zero for a header alone. */
  bodyOrder: number;
}

export interface ChainBackend {
  /** Records in original header insertion order, including genesis. */
  records(): Iterable<ChainRecord>;
  saveRecord(record: ChainRecord): void;
  activeTip(): string | undefined;
  setActiveTip(hash: string): void;
  bestHeader(): string | undefined;
  setBestHeader(hash: string): void;
  putBlock(hash: string, bytes: Buffer): void;
  getBlock(hash: string): Buffer;
  putUndo(hash: string, changes: Changes): void;
  getUndo(hash: string): Changes;
  coins: CoinView;
}

class MemoryCoins extends Map<string, Coin> implements CoinView {
  *ordered(): IterableIterator<[string, Coin]> {
    for (const key of [...this.keys()].sort()) yield [key, this.get(key)!];
  }
}

export class MemoryBackend implements ChainBackend {
  readonly coins = new MemoryCoins();
  private readonly blocks = new Map<string, Buffer>();
  private readonly undo = new Map<string, Changes>();

  private readonly headers = new Map<string, ChainRecord>();
  private active?: string;
  private best?: string;
  records(): Iterable<ChainRecord> { return this.headers.values(); }
  saveRecord(record: ChainRecord): void { this.headers.set(record.hash, record); }
  activeTip(): string | undefined { return this.active; }
  setActiveTip(hash: string): void { this.active = hash; }
  bestHeader(): string | undefined { return this.best; }
  setBestHeader(hash: string): void { this.best = hash; }
  putBlock(hash: string, bytes: Buffer): void { this.blocks.set(hash, bytes); }
  getBlock(hash: string): Buffer {
    const block = this.blocks.get(hash);
    if (!block) throw new Error(`Missing stored block ${hash}`);
    return block;
  }
  putUndo(hash: string, changes: Changes): void { this.undo.set(hash, changes); }
  getUndo(hash: string): Changes {
    const changes = this.undo.get(hash);
    if (!changes) throw new Error(`Missing block undo ${hash}`);
    return changes;
  }
}
