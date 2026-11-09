import { createHash } from 'node:crypto';

/** Cursor for the little-endian wire encodings in chapter 03. */
export class Reader {
  readonly data: Buffer;
  offset = 0;

  constructor(data: Buffer) {
    this.data = data;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  read(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new RangeError('end of data');
    }
    const start = this.offset;
    this.offset += length;
    return this.data.subarray(start, this.offset);
  }

  u8(): number { return this.read(1)[0]; }
  u16(): number { return this.read(2).readUInt16LE(); }
  u32(): number { return this.read(4).readUInt32LE(); }
  i32(): number { return this.read(4).readInt32LE(); }
  u64(): bigint { return this.read(8).readBigUInt64LE(); }
  i64(): bigint { return this.read(8).readBigInt64LE(); }

  compact(): number {
    const first = this.u8();
    if (first < 0xfd) return first;
    const value = first === 0xfd ? BigInt(this.u16()) : first === 0xfe ? BigInt(this.u32()) : this.u64();
    const minimum = first === 0xfd ? 0xfdn : first === 0xfe ? 0x10000n : 0x100000000n;
    if (value < minimum) throw new RangeError('non-canonical ReadCompactSize()');
    if (value > 0x02000000n) throw new RangeError('ReadCompactSize(): size too large');
    return Number(value);
  }

  varBytes(): Buffer { return this.read(this.compact()); }
}

export function u32le(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(value);
  return out;
}

export function i64le(value: bigint): Buffer {
  const out = Buffer.allocUnsafe(8);
  out.writeBigInt64LE(value);
  return out;
}

export function compactSize(value: number | bigint): Buffer {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('invalid CompactSize');
  if (value < 0 || value > 0xffffffffffffffffn) throw new RangeError('invalid CompactSize');
  if (value < 0xfd) return Buffer.from([Number(value)]);
  const width = value <= 0xffff ? 2 : value <= 0xffffffff ? 4 : 8;
  const out = Buffer.allocUnsafe(1 + width);
  out[0] = width === 2 ? 0xfd : width === 4 ? 0xfe : 0xff;
  if (width === 8) out.writeBigUInt64LE(BigInt(value), 1);
  else out.writeUIntLE(Number(value), 1, width);
  return out;
}

export function varBytes(data: Buffer): Buffer {
  return Buffer.concat([compactSize(data.length), data]);
}

export function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hash256(data: Buffer): Buffer { return sha256(sha256(data)); }

export function hash160(data: Buffer): Buffer {
  return createHash('ripemd160').update(sha256(data)).digest();
}

export function taggedHash(tag: string, data: Buffer): Buffer {
  const prefix = sha256(Buffer.from(tag, 'utf8'));
  return createHash('sha256').update(prefix).update(prefix).update(data).digest();
}
