import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Chain } from './chain.js';
import { networkName, networkOptions } from './input.js';
import { SqliteBackend } from './sqlite-backend.js';
import { ScriptPool } from './script-pool.js';

const MAX_BATCH_BLOCKS = 32;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_AGE_MS = 1_000;

export interface ChainStoreOptions {
  /** Total script verification threads including the calling thread. Use 1 for serial execution. */
  scriptThreads?: number;
}

function queries(chain: Chain, requireOpen: () => void) {
  // Callers may retain this view even after a failed write closes the store.
  function read<Args extends unknown[], Result>(method: (...args: Args) => Result) {
    return (...args: Args) => {
      requireOpen();
      return method.apply(chain, args);
    };
  }
  return {
    params: chain.params, tip: read(chain.tip), tips: read(chain.tips),
    bestHeader: read(chain.bestHeader), utxoHash: read(chain.utxoHash),
    locator: read(chain.locator), missingBlocks: read(chain.missingBlocks),
    hasHeader: read(chain.hasHeader), answerHeaders: read(chain.answerHeaders),
    isAncestor: read(chain.isAncestor), bestOfferedHeader: read(chain.bestOfferedHeader), hasBestWork: read(chain.hasBestWork),
  };
}

/** Holds exclusive access to one chain database until close(). */
export class ChainStore {
  readonly chain: ReturnType<typeof queries>;
  readonly #state: Chain;
  readonly #db: DatabaseSync;
  readonly #scripts: ScriptPool;
  #open = true;
  #batch?: { blocks: number; bytes: number; started: number };

  constructor(directory: string, network: string, options: object = {}, runtime: ChainStoreOptions = {}) {
    networkName(network);
    const config = networkOptions(options, network);
    this.#scripts = new ScriptPool(runtime.scriptThreads);
    mkdirSync(directory, { recursive: true });
    this.#db = new DatabaseSync(join(directory, 'chain.sqlite'));
    try {
      this.#db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE');
      const backend = new SqliteBackend(this.#db, JSON.stringify({ format: 1, network, options: config }));
      this.#db.exec('CREATE TABLE IF NOT EXISTS peers (address TEXT NOT NULL UNIQUE)');
      this.#state = new Chain(network, config, backend, this.#scripts);
      this.chain = queries(this.#state, () => this.requireOpen());
      this.#db.exec('COMMIT');
    } catch (error) {
      this.discard();
      throw error;
    }
  }

  private requireOpen() {
    if (!this.#open) throw new Error('Chain database is closed');
  }

  // Persist branch flags and undo together with the active tip and its UTXOs.
  // On failure SQLite rolls back on close. Discard the in-memory block index as well.
  private update<T>(operation: () => T): T {
    this.requireOpen();
    this.flushBlocks();
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.discard();
      throw error;
    }
  }

  /** Recently handshaken public peers, most recent first. Each database belongs to one network. */
  knownPeers(): string[] {
    this.requireOpen();
    return this.#db.prepare('SELECT address FROM peers ORDER BY rowid DESC LIMIT 16').all().map(row => String(row.address));
  }

  rememberPeer(address: string) {
    this.update(() => {
      this.#db.prepare('INSERT OR REPLACE INTO peers(address) VALUES (?)').run(address);
      this.#db.exec('DELETE FROM peers WHERE rowid NOT IN (SELECT rowid FROM peers ORDER BY rowid DESC LIMIT 16)');
    });
  }

  forgetPeer(address: string) {
    this.update(() => this.#db.prepare('DELETE FROM peers WHERE address=?').run(address));
  }

  headers(headers: Buffer[], now: number) {
    return this.update(() => this.#state.processHeaders(headers, now, 'p2p'));
  }
  block(block: Buffer, now: number, requested = true) {
    return this.update(() => this.#state.processBlock(block, now, 'p2p', requested));
  }

  /** Validate immediately, grouping consecutive downloaded bodies into durable transactions. */
  downloadBlock(block: Buffer, now: number, requested = true) {
    this.requireOpen();
    try {
      if (this.#batch && this.#batch.bytes + block.length > MAX_BATCH_BYTES) this.flushBlocks();
      if (!this.#batch) {
        this.#db.exec('BEGIN IMMEDIATE');
        this.#batch = { blocks: 0, bytes: 0, started: performance.now() };
      }
      const batch = this.#batch;
      const result = this.#state.processBlock(block, now, 'p2p', requested);
      batch.blocks++;
      batch.bytes += block.length;
      if (batch.blocks >= MAX_BATCH_BLOCKS || batch.bytes >= MAX_BATCH_BYTES ||
          performance.now() - batch.started >= MAX_BATCH_AGE_MS) this.flushBlocks();
      return result;
    } catch (error) {
      this.discard();
      throw error;
    }
  }

  /** Commit a partial group when a download is idle or before reporting completion. */
  flushBlocks(): void {
    if (!this.#batch) return;
    try {
      this.#db.exec('COMMIT');
      this.#batch = undefined;
    } catch (error) {
      this.discard();
      throw error;
    }
  }

  invalidate(hash: string) {
    return this.update(() => this.#state.invalidate(hash));
  }
  close() {
    this.flushBlocks();
    this.discard();
  }

  // Closing SQLite with an active transaction rolls it back. Never flush a failed write.
  private discard() {
    if (this.#open) {
      this.#batch = undefined;
      this.#scripts.close();
      this.#db.close();
      this.#open = false;
    }
  }
}
