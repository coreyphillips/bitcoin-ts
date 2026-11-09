import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ChainBackend, ChainRecord } from './chain-backend.js';
import type { Changes, Coin, CoinView } from './coins.js';
import { Reader, compactSize, u32le } from './codec.js';
import { serializeOutput } from './tx.js';

const schema = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS headers (
    id INTEGER PRIMARY KEY, hash BLOB UNIQUE NOT NULL, header BLOB NOT NULL,
    linked INTEGER NOT NULL, failed INTEGER NOT NULL, connected INTEGER NOT NULL, body_order INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocks (hash BLOB PRIMARY KEY, body BLOB NOT NULL, undo BLOB) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS coins (
    outpoint BLOB PRIMARY KEY, height INTEGER NOT NULL, coinbase INTEGER NOT NULL,
    amount INTEGER NOT NULL, script BLOB NOT NULL
  ) WITHOUT ROWID;
`;

type Row = ReturnType<StatementSync['all']>[number];
const bytes = (value: Row[string]) => Buffer.from(value as Uint8Array);
const fromHex = (key: string) => Buffer.from(key, 'hex');
function readCoin(row: Row): Coin {
  return { height: Number(row.height), coinbase: Boolean(row.coinbase),
    output: { value: BigInt(row.amount as number | bigint), script: bytes(row.script) } };
}

// A block can both create and spend a coin. Store the pre-block value for each touched key.
function encodeUndo(undo: Changes): Buffer {
  const parts = [compactSize(undo.size)];
  for (const [key, coin] of undo) {
    parts.push(fromHex(key), Buffer.of(coin ? 1 : 0));
    if (coin) parts.push(u32le(coin.height * 2 + Number(coin.coinbase)), serializeOutput(coin.output));
  }
  return Buffer.concat(parts);
}

function decodeUndo(blob: Buffer): Changes {
  const result: Changes = new Map();
  const r = new Reader(blob);
  const length = r.compact();
  for (let i = 0; i < length; i++) {
    const key = r.read(36).toString('hex');
    const flag = r.u8();
    if (flag === 0) result.set(key, undefined);
    else if (flag === 1) {
      const code = r.u32();
      result.set(key, { height: code >>> 1, coinbase: Boolean(code & 1),
        output: { value: r.i64(), script: r.varBytes() } });
    } else throw new Error('Invalid undo coin flag');
  }
  if (r.remaining) throw new Error('Trailing data in block undo');
  return result;
}

class SqlCoins implements CoinView {
  private readonly lookup: StatementSync;
  private readonly exists: StatementSync;
  private readonly insert: StatementSync;
  private readonly remove: StatementSync;
  private readonly scan: StatementSync;
  constructor(db: DatabaseSync) {
    this.lookup = db.prepare('SELECT * FROM coins WHERE outpoint=?');
    this.exists = db.prepare('SELECT 1 FROM coins WHERE outpoint=?');
    this.insert = db.prepare('INSERT OR REPLACE INTO coins VALUES (?, ?, ?, ?, ?)');
    this.remove = db.prepare('DELETE FROM coins WHERE outpoint=?');
    this.scan = db.prepare('SELECT * FROM coins ORDER BY outpoint');
  }
  get(key: string) {
    const row = this.lookup.get(fromHex(key));
    return row ? readCoin(row) : undefined;
  }
  has(key: string) { return !!this.exists.get(fromHex(key)); }
  set(key: string, coin: Coin) {
    this.insert.run(fromHex(key), coin.height, Number(coin.coinbase), coin.output.value, coin.output.script);
  }
  delete(key: string) { this.remove.run(fromHex(key)); }
  *ordered(): IterableIterator<[string, Coin]> {
    for (const row of this.scan.iterate()) yield [bytes(row.outpoint).toString('hex'), readCoin(row)];
  }
}

export class SqliteBackend implements ChainBackend {
  readonly coins: SqlCoins;
  private readonly queries = new Map<string, StatementSync>();
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync, settings: string) {
    this.db = db;
    db.exec(schema);
    this.sql("INSERT OR IGNORE INTO meta VALUES ('config', ?)").run(settings);
    if (this.meta('config') !== settings) throw new Error('Data directory belongs to a different network, format or configuration');
    this.coins = new SqlCoins(db);
  }
  private sql(query: string): StatementSync {
    let stmt = this.queries.get(query);
    if (!stmt) { stmt = this.db.prepare(query); this.queries.set(query, stmt); }
    return stmt;
  }
  private meta(key: string) { return this.sql('SELECT value FROM meta WHERE key=?').get(key)?.value as string | undefined; }
  private setMeta(key: string, value: string) { this.sql('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, value); }
  activeTip() { return this.meta('tip'); }
  bestHeader() { return this.meta('best'); }
  setActiveTip(hash: string) { this.setMeta('tip', hash); }
  setBestHeader(hash: string) { this.setMeta('best', hash); }
  *records(): IterableIterator<ChainRecord> {
    for (const row of this.sql('SELECT * FROM headers ORDER BY id').iterate()) {
      yield { hash: bytes(row.hash).toString('hex'), header: bytes(row.header), linked: Number(row.linked),
        failed: Boolean(row.failed), connected: Boolean(row.connected), bodyOrder: Number(row.body_order) };
    }
  }
  saveRecord(r: ChainRecord) {
    this.sql(`INSERT INTO headers(hash, header, linked, failed, connected, body_order) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET linked=excluded.linked, failed=excluded.failed,
        connected=excluded.connected, body_order=excluded.body_order`)
      .run(fromHex(r.hash), r.header, r.linked, Number(r.failed), Number(r.connected), r.bodyOrder);
  }
  putBlock(hash: string, block: Buffer) { this.sql('INSERT INTO blocks(hash, body) VALUES (?, ?)').run(fromHex(hash), block); }
  getBlock(hash: string) {
    const row = this.sql('SELECT body FROM blocks WHERE hash=?').get(fromHex(hash));
    if (!row) throw new Error(`Missing block ${hash}`);
    return bytes(row.body);
  }
  putUndo(hash: string, changes: Changes) {
    if (!this.sql('UPDATE blocks SET undo=? WHERE hash=?').run(encodeUndo(changes), fromHex(hash)).changes) {
      throw new Error(`Missing block for undo ${hash}`);
    }
  }
  getUndo(hash: string) {
    const row = this.sql('SELECT undo FROM blocks WHERE hash=?').get(fromHex(hash));
    if (!row?.undo) throw new Error(`Missing undo for block ${hash}`);
    return decodeUndo(bytes(row.undo));
  }
}
