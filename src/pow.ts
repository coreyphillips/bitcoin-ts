import { hash256 } from './codec.js';
import type { NetworkParams } from './params.js';

export interface Header {
  raw: Buffer;
  hash: string;
  previous: string;
  merkle: Buffer;
  version: number;
  time: number;
  bits: number;
}

export function parseHeader(raw: Buffer): Header {
  if (raw.length !== 80) throw new Error('header must contain 80 bytes');
  return {
    raw, hash: hash256(raw).reverse().toString('hex'), previous: Buffer.from(raw.subarray(4, 36)).reverse().toString('hex'),
    merkle: raw.subarray(36, 68), version: raw.readInt32LE(0), time: raw.readUInt32LE(68), bits: raw.readUInt32LE(72),
  };
}

/** A zero return value also represents an invalid target (negative, overflow or zero). */
export function compactToTarget(bits: number): bigint {
  const size = bits >>> 24;
  let word = bits & 0x7fffff;
  if (size <= 3) word >>>= 8 * (3 - size);
  if ((bits & 0x800000) !== 0 || size > 34 || (size > 33 && word > 0xff) || (size > 32 && word > 0xffff)) return 0n;
  return BigInt(word) << BigInt(8 * Math.max(0, size - 3));
}

export function targetToCompact(target: bigint): number {
  if (target === 0n) return 0;
  let size = Math.ceil(target.toString(16).length / 2);
  let mantissa = Number(target >> BigInt(8 * (size - 3)));
  if (mantissa & 0x800000) {
    mantissa >>>= 8;
    size++;
  }
  return size * 0x1000000 + mantissa;
}

export function blockProof(bits: number): bigint {
  const target = compactToTarget(bits);
  return target ? (1n << 256n) / (target + 1n) : 0n;
}

export function validProof(header: Header, limit: bigint): boolean {
  const target = compactToTarget(header.bits);
  return target > 0n && target <= limit && BigInt('0x' + header.hash) <= target;
}

export interface HeaderNode {
  header: Header;
  parent?: HeaderNode;
  height: number;
  mtp: number;
}

export function requiredBits(params: NetworkParams, parent: HeaderNode, time: number, ancestor: (height: number) => HeaderNode): number {
  const height = parent.height + 1;
  if (height % params.interval !== 0) {
    if (!params.minDifficulty) return parent.header.bits;
    const easiest = targetToCompact(params.powLimit);
    if (time > parent.header.time + 1200) return easiest;
    let cursor = parent;
    while (cursor.parent && cursor.height % params.interval && cursor.header.bits === easiest) cursor = cursor.parent;
    return cursor.header.bits;
  }
  if (params.noRetarget) return parent.header.bits;
  const first = ancestor(height - params.interval).header;
  const span = Math.max(params.timespan / 4, Math.min(params.timespan * 4, parent.header.time - first.time));
  const target = compactToTarget(params.bip94 ? first.bits : parent.header.bits) * BigInt(span) / BigInt(params.timespan);
  return targetToCompact(target < params.powLimit ? target : params.powLimit);
}

export type OutcomeKind = 'invalid' | 'mutated' | 'temporary' | 'orphan';
export class BlockFailure extends Error {
  constructor(public readonly result: OutcomeKind, reason: string) { super(reason); }
}

export function checkHeaderContext(header: Header, parent: HeaderNode, params: NetworkParams, now: number, ancestor: (height: number) => HeaderNode): void {
  const height = parent.height + 1;
  if (header.bits !== requiredBits(params, parent, header.time, ancestor)) throw new BlockFailure('invalid', 'bad-diffbits');
  if (header.time <= parent.mtp) throw new BlockFailure('invalid', 'time-too-old');
  if (params.bip94 && height % params.interval === 0 && header.time < parent.header.time - 600) {
    throw new BlockFailure('invalid', 'time-timewarp-attack');
  }
  if (header.time > now + 7200) throw new BlockFailure('temporary', 'time-too-new');
  if ((header.version < 2 && height >= params.heights.bip34) || (header.version < 3 && height >= params.heights.dersig)
      || (header.version < 4 && height >= params.heights.cltv)) {
    throw new BlockFailure('invalid', `bad-version(0x${(header.version >>> 0).toString(16).padStart(8, '0')})`);
  }
}
