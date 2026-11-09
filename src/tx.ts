import { Reader, compactSize, hash256, i64le, u32le, varBytes } from './codec.js';

export interface TxInput {
  /** Previous transaction id, in wire order. */
  hash: Buffer;
  index: number;
  script: Buffer;
  sequence: number;
  witness: Buffer[];
}

export interface TxOutput {
  value: bigint;
  script: Buffer;
}

export interface Transaction {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  locktime: number;
}

export const MAX_MONEY = 21_000_000n * 100_000_000n;
const zeroHash = Buffer.alloc(32);

function readInputs(reader: Reader, count: number): TxInput[] {
  // Every input takes at least 41 bytes. Reject impossible counts before allocating.
  if (count > Math.floor(reader.remaining / 41)) throw new RangeError('end of data');
  const inputs: TxInput[] = [];
  for (let i = 0; i < count; i++) {
    const hash = reader.read(32);
    const index = reader.u32();
    const script = reader.varBytes();
    inputs.push({ hash, index, script, sequence: reader.u32(), witness: [] });
  }
  return inputs;
}

function readOutputs(reader: Reader): TxOutput[] {
  const count = reader.compact();
  if (count > Math.floor(reader.remaining / 9)) throw new RangeError('end of data');
  const outputs: TxOutput[] = [];
  for (let i = 0; i < count; i++) outputs.push({ value: reader.i64(), script: reader.varBytes() });
  return outputs;
}

export function readTransaction(reader: Reader): Transaction {
  const version = reader.u32();
  let inputs = readInputs(reader, reader.compact());
  let outputs: TxOutput[] = [];
  let flags = 0;
  if (inputs.length === 0) {
    flags = reader.u8();
    if (flags !== 0) {
      inputs = readInputs(reader, reader.compact());
      outputs = readOutputs(reader);
    }
  } else {
    outputs = readOutputs(reader);
  }
  if ((flags & 1) !== 0) {
    flags ^= 1;
    for (const input of inputs) {
      const count = reader.compact();
      if (count > reader.remaining) throw new RangeError('end of data');
      for (let i = 0; i < count; i++) input.witness.push(reader.varBytes());
    }
    if (!inputs.some(input => input.witness.length > 0)) throw new Error('Superfluous witness record');
  }
  if (flags !== 0) throw new Error('Unknown transaction optional data');
  return { version, inputs, outputs, locktime: reader.u32() };
}

export function parseTransaction(data: Buffer): Transaction {
  const reader = new Reader(data);
  const tx = readTransaction(reader);
  if (reader.remaining !== 0) throw new Error('trailing data');
  return tx;
}

export function serializeOutpoint(input: TxInput): Buffer {
  if (input.hash.length !== 32) throw new RangeError('outpoint hash must be 32 bytes');
  return Buffer.concat([input.hash, u32le(input.index)]);
}

export function serializeOutput(output: TxOutput): Buffer {
  return Buffer.concat([i64le(output.value), varBytes(output.script)]);
}

export function serializeTransaction(tx: Transaction, witness = true): Buffer {
  const parts = [u32le(tx.version)];
  const extended = witness && tx.inputs.some(input => input.witness.length > 0);
  if (extended) parts.push(Buffer.from([0, 1]));
  parts.push(compactSize(tx.inputs.length));
  for (const input of tx.inputs) {
    parts.push(serializeOutpoint(input), varBytes(input.script), u32le(input.sequence));
  }
  parts.push(compactSize(tx.outputs.length));
  for (const output of tx.outputs) parts.push(serializeOutput(output));
  if (extended) {
    for (const input of tx.inputs) {
      parts.push(compactSize(input.witness.length));
      for (const item of input.witness) parts.push(compactSize(item.length), item);
    }
  }
  parts.push(u32le(tx.locktime));
  return Buffer.concat(parts);
}

export function txid(tx: Transaction): Buffer { return hash256(serializeTransaction(tx, false)); }
export function wtxid(tx: Transaction): Buffer { return hash256(serializeTransaction(tx, true)); }

export function strippedSize(tx: Transaction): number {
  let size = 8 + compactSize(tx.inputs.length).length + compactSize(tx.outputs.length).length;
  for (const { script } of tx.inputs) size += 40 + compactSize(script.length).length + script.length;
  for (const { script } of tx.outputs) size += 8 + compactSize(script.length).length + script.length;
  return size;
}

function isNullOutpoint(input: TxInput): boolean {
  return input.index === 0xffffffff && input.hash.equals(zeroHash);
}

export function isCoinbase(tx: Transaction): boolean {
  return tx.inputs.length === 1 && isNullOutpoint(tx.inputs[0]);
}

export function checkTransaction(tx: Transaction): string | null {
  if (tx.inputs.length === 0) return 'bad-txns-vin-empty';
  if (tx.outputs.length === 0) return 'bad-txns-vout-empty';
  if (strippedSize(tx) > 1_000_000) return 'bad-txns-oversize';
  let sum = 0n;
  for (const { value } of tx.outputs) {
    if (value < 0n) return 'bad-txns-vout-negative';
    if (value > MAX_MONEY) return 'bad-txns-vout-toolarge';
    sum += value;
    if (sum > MAX_MONEY) return 'bad-txns-txouttotal-toolarge';
  }
  const seen = new Set<string>();
  for (const input of tx.inputs) {
    const key = input.hash.toString('hex') + ':' + input.index;
    if (seen.has(key)) return 'bad-txns-inputs-duplicate';
    seen.add(key);
  }
  if (isCoinbase(tx)) {
    const length = tx.inputs[0].script.length;
    if (length < 2 || length > 100) return 'bad-cb-length';
  } else if (tx.inputs.some(isNullOutpoint)) {
    return 'bad-txns-prevout-null';
  }
  return null;
}

export function isFinalTx(tx: Transaction, blockHeight: number, blockTime: number): boolean {
  const limit = tx.locktime < 500_000_000 ? blockHeight : blockTime;
  return tx.locktime === 0 || tx.locktime < limit || tx.inputs.every(input => input.sequence === 0xffffffff);
}
