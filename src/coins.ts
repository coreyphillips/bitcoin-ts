import { createHash } from 'node:crypto';
import { type Block } from './block.js';
import { sha256, u32le } from './codec.js';
import { scriptMessages } from './block-errors.js';
import { blockFlags, type NetworkParams } from './params.js';
import { BlockFailure } from './pow.js';
import { transactionSigOpCost } from './script.js';
import { verifyChecks, type ScriptCheck } from './script-checks.js';
import type { ScriptPool } from './script-pool.js';
import { MAX_MONEY, serializeOutput, type Transaction, type TxOutput } from './tx.js';

export interface Coin {
  output: TxOutput;
  height: number;
  coinbase: boolean;
}

export interface CoinView {
  get(key: string): Coin | undefined;
  has(key: string): boolean;
  set(key: string, coin: Coin): void;
  delete(key: string): void;
  /** Coin keys in ascending byte order. */
  ordered(): Iterable<[string, Coin]>;
}
export type Changes = Map<string, Coin | undefined>;

// The key order is bytewise txid followed by numeric output index (chapter 15).
function key(id: string, index: number): string {
  return id + index.toString(16).padStart(8, '0');
}

const repeats: Record<number, string> = {
  91842: '00000000000a4d0a398161ffc163c503763b1f4360639393e0e4c8e300e0caec',
  91880: '00000000000743f190a18c5577a3c2d2a1f610ae9601ac046a38084ccb7cd721',
};

function invalid(reason: string): never { throw new BlockFailure('invalid', reason); }

function outputTotal(tx: Transaction): bigint {
  return tx.outputs.reduce((sum, output) => sum + output.value, 0n);
}

function checkSequenceLocks(tx: Transaction, coins: Coin[], height: number, parentMtp: number, mtpAt: (h: number) => number) {
  if ((tx.version >>> 0) < 2) return;
  for (let i = 0; i < coins.length; i++) {
    const sequence = tx.inputs[i].sequence;
    if (sequence & 0x80000000) continue;
    const units = sequence & 0xffff;
    if (sequence & 0x400000) {
      const start = mtpAt(Math.max(coins[i].height - 1, 0));
      if (parentMtp < start + units * 512) invalid('bad-txns-nonfinal');
    } else if (height < coins[i].height + units) invalid('bad-txns-nonfinal');
  }
}

export function applyChanges(utxo: CoinView, changes: Changes): void {
  for (const [outpoint, coin] of changes) {
    if (coin) utxo.set(outpoint, coin);
    else utxo.delete(outpoint);
  }
}

export function connectBlock(
  block: Block, height: number, parentMtp: number, mtpAt: (h: number) => number,
  utxo: CoinView, params: NetworkParams, onBip34Chain: boolean, scripts?: ScriptPool,
): Changes {
  const changes: Changes = new Map();
  const flags = blockFlags(params, block.header.hash, height);
  const txids = block.ids.map(id => id.toString('hex'));
  if (height >= 1983702 || (!onBip34Chain && repeats[height] !== block.header.hash)) {
    for (let i = 0; i < txids.length; i++) {
      for (let vout = 0; vout < block.transactions[i].outputs.length; vout++) {
        if (utxo.has(key(txids[i], vout))) invalid('bad-txns-BIP30');
      }
    }
  }
  let fees = 0n;
  let sigops = 0;
  const scriptChecks: ScriptCheck[] = [];
  for (let i = 0; i < block.transactions.length; i++) {
    const tx = block.transactions[i];
    const spent: TxOutput[] = [];
    if (i > 0) {
      const coins: Coin[] = [];
      const inputs = tx.inputs.map(input => key(input.hash.toString('hex'), input.index));
      for (const outpoint of inputs) {
        const coin = changes.has(outpoint) ? changes.get(outpoint) : utxo.get(outpoint);
        if (!coin) invalid('bad-txns-inputs-missingorspent');
        coins.push(coin);
        spent.push(coin.output);
      }
      let valueIn = 0n;
      for (const coin of coins) {
        if (coin.coinbase && height - coin.height < 100) invalid('bad-txns-premature-spend-of-coinbase');
        valueIn += coin.output.value;
        if (coin.output.value < 0n || valueIn > MAX_MONEY) invalid('bad-txns-inputvalues-outofrange');
      }
      const fee = valueIn - outputTotal(tx);
      if (fee < 0n) invalid('bad-txns-in-belowout');
      if (fee > MAX_MONEY) invalid('bad-txns-fee-outofrange');
      fees += fee;
      if (fees > MAX_MONEY) invalid('bad-txns-accumulated-fee-outofrange');
      if (height >= params.heights.csv) checkSequenceLocks(tx, coins, height, parentMtp, mtpAt);
      scriptChecks.push({ tx, spent });
      for (const outpoint of inputs) changes.set(outpoint, undefined);
    }
    sigops += transactionSigOpCost(tx, spent, flags);
    if (sigops > 80000) invalid('bad-blk-sigops');
    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const output = tx.outputs[vout];
      if (output.script[0] !== 0x6a && output.script.length <= 10000) {
        changes.set(key(txids[i], vout), { height, coinbase: i === 0, output });
      }
    }
  }
  const reward = 5000000000n >> BigInt(Math.floor(height / params.halving));
  if (outputTotal(block.transactions[0]) > reward + fees) invalid('bad-cb-amount');
  const error = scripts ? scripts.verify(scriptChecks, flags) : verifyChecks(scriptChecks, flags);
  if (error !== 'OK') invalid(`block-script-verify-flag-failed (${scriptMessages[error] ?? error})`);
  const undo: Changes = new Map();
  for (const outpoint of changes.keys()) undo.set(outpoint, utxo.get(outpoint));
  // Core's historical duplicate coinbases replaced the earlier outputs permanently.
  if (repeats[height] === block.header.hash) {
    for (let vout = 0; vout < block.transactions[0].outputs.length; vout++) undo.set(key(txids[0], vout), undefined);
  }
  applyChanges(utxo, changes);
  return undo;
}

export function utxoFingerprint(utxo: CoinView) {
  const stream = createHash('sha256');
  let txouts = 0;
  for (const [outpoint, coin] of utxo.ordered()) {
    txouts++;
    stream.update(Buffer.from(outpoint.slice(0, 64), 'hex'));
    stream.update(u32le(Number.parseInt(outpoint.slice(64), 16)));
    stream.update(u32le(coin.height * 2 + Number(coin.coinbase)));
    stream.update(serializeOutput(coin.output));
  }
  return { hash_serialized_3: sha256(stream.digest()).reverse().toString('hex'), txouts };
}
