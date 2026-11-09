import { compactSize, hash256, i64le, sha256, taggedHash, u32le, varBytes } from './codec.js';
import { readOp } from './script-encoding.js';
import { serializeOutpoint, serializeOutput, type Transaction, type TxOutput } from './tx.js';

const zeroHash = Buffer.alloc(32);
const nullOutput = serializeOutput({ value: -1n, script: Buffer.alloc(0) });

// On a malformed operation Core stops writing at the parse cursor but keeps the declared size.
function legacyScriptCode(script: Buffer): Buffer {
  const parts: Buffer[] = [];
  const cursor = { offset: 0 };
  let start = 0;
  let separators = 0;
  for (;;) {
    const op = readOp(script, cursor);
    if (!op) break;
    if (op.opcode === 0xab) {
      parts.push(script.subarray(start, cursor.offset - 1));
      start = cursor.offset;
      separators++;
    }
  }
  parts.push(script.subarray(start, cursor.offset));
  return Buffer.concat([compactSize(script.length - separators), ...parts]);
}

export function legacySighash(tx: Transaction, index: number, script: Buffer, hashType: number): Buffer {
  if (!tx.inputs[index]) throw new RangeError('input index out of bounds');
  const mode = hashType & 0x1f;
  const single = mode === 3;
  const none = mode === 2;
  if (single && index >= tx.outputs.length) {
    const one = Buffer.alloc(32);
    one[0] = 1;
    return one;
  }
  const anyoneCanPay = (hashType & 0x80) !== 0;
  const count = anyoneCanPay ? 1 : tx.inputs.length;
  const parts = [u32le(tx.version), compactSize(count)];
  for (let i = 0; i < count; i++) {
    const position = anyoneCanPay ? index : i;
    const input = tx.inputs[position];
    const signing = position === index;
    parts.push(serializeOutpoint(input), signing ? legacyScriptCode(script) : Buffer.from([0]));
    parts.push(u32le(!signing && (single || none) ? 0 : input.sequence));
  }
  const outputs = none ? 0 : single ? index + 1 : tx.outputs.length;
  parts.push(compactSize(outputs));
  for (let i = 0; i < outputs; i++) parts.push(single && i !== index ? nullOutput : serializeOutput(tx.outputs[i]));
  parts.push(u32le(tx.locktime), u32le(hashType >>> 0));
  return hash256(Buffer.concat(parts));
}

/** Reuse only for a single, unchanged transaction and its unchanged spent outputs. */
export class SighashCache {
  readonly prevouts: Buffer;
  readonly sequences: Buffer;
  readonly outputs: Buffer;
  readonly amounts: Buffer;
  readonly scripts: Buffer;

  constructor(tx: Transaction, spent: readonly TxOutput[]) {
    this.prevouts = sha256(Buffer.concat(tx.inputs.map(serializeOutpoint)));
    this.sequences = sha256(Buffer.concat(tx.inputs.map(input => u32le(input.sequence))));
    this.outputs = sha256(Buffer.concat(tx.outputs.map(serializeOutput)));
    this.amounts = sha256(Buffer.concat(spent.map(output => i64le(output.value))));
    this.scripts = sha256(Buffer.concat(spent.map(output => varBytes(output.script))));
  }
}

export function witnessV0Sighash(
  tx: Transaction, index: number, script: Buffer, amount: bigint, hashType: number,
  cache?: SighashCache,
): Buffer {
  const input = tx.inputs[index];
  if (!input) throw new RangeError('input index out of bounds');
  const pre = cache ?? new SighashCache(tx, []);
  const mode = hashType & 0x1f;
  const anyoneCanPay = (hashType & 0x80) !== 0;
  const allOutputs = mode !== 2 && mode !== 3;
  let outputHash: Buffer = zeroHash;
  if (allOutputs) outputHash = sha256(pre.outputs);
  else if (mode === 3 && tx.outputs[index]) outputHash = hash256(serializeOutput(tx.outputs[index]));
  return hash256(Buffer.concat([
    u32le(tx.version),
    anyoneCanPay ? zeroHash : sha256(pre.prevouts),
    !anyoneCanPay && allOutputs ? sha256(pre.sequences) : zeroHash,
    serializeOutpoint(input), varBytes(script), i64le(amount), u32le(input.sequence),
    outputHash, u32le(tx.locktime), u32le(hashType >>> 0),
  ]));
}

export function taprootSighash(
  tx: Transaction, index: number, spent: readonly TxOutput[], hashType: number,
  annex?: Buffer, leafHash?: Buffer, codesep = 0xffffffff, cache?: SighashCache,
): Buffer | null {
  if (!tx.inputs[index] || spent.length !== tx.inputs.length) throw new RangeError('missing input or spent output');
  if (leafHash !== undefined && leafHash.length !== 32) throw new RangeError('invalid tapleaf hash');
  if (![0, 1, 2, 3, 0x81, 0x82, 0x83].includes(hashType)) return null;
  const mode = hashType === 0 ? 1 : hashType & 3;
  if (mode === 3 && index >= tx.outputs.length) return null;
  const anyoneCanPay = (hashType & 0x80) !== 0;
  const parts = [Buffer.from([0, hashType]), u32le(tx.version), u32le(tx.locktime)];
  if (!anyoneCanPay || mode === 1) {
    const pre = cache ?? new SighashCache(tx, spent);
    if (!anyoneCanPay) parts.push(pre.prevouts, pre.amounts, pre.scripts, pre.sequences);
    if (mode === 1) parts.push(pre.outputs);
  }
  parts.push(Buffer.from([(leafHash === undefined ? 0 : 2) + Number(annex !== undefined)]));
  if (anyoneCanPay) {
    const input = tx.inputs[index];
    parts.push(serializeOutpoint(input), serializeOutput(spent[index]), u32le(input.sequence));
  } else {
    parts.push(u32le(index));
  }
  if (annex !== undefined) parts.push(sha256(varBytes(annex)));
  if (mode === 3) parts.push(sha256(serializeOutput(tx.outputs[index])));
  if (leafHash !== undefined) parts.push(leafHash, Buffer.from([0]), u32le(codesep));
  return taggedHash('TapSighash', Buffer.concat(parts));
}
