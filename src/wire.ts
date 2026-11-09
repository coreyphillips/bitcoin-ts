import { randomBytes } from 'node:crypto';
import { Reader, compactSize, hash256, i64le, u32le, varBytes } from './codec.js';

export const VERSION = 70016;
export const MAX_PAYLOAD = 4_000_000;
export const WITNESS_BLOCK = 0x40000002;
const empty = Buffer.alloc(0);
export function displayHash(raw: Buffer): string { return Buffer.from(raw).reverse().toString('hex'); }
export function wireHash(hash: string): Buffer { return Buffer.from(hash, 'hex').reverse(); }

export function frame(magic: Buffer, command: string, payload: Buffer = empty): Buffer {
  if (!/^[a-z0-9]{1,12}$/.test(command) || payload.length > MAX_PAYLOAD) throw new Error('Invalid outbound message');
  const header = Buffer.alloc(24);
  magic.copy(header);
  header.write(command, 4, 'ascii');
  header.writeUInt32LE(payload.length, 16);
  hash256(payload).copy(header, 20, 0, 4);
  return Buffer.concat([header, payload]);
}

/** Check the prefix before allocating a payload and copy each input byte at most once. */
export class FrameReader {
  private header = Buffer.alloc(24);
  private payload: Buffer | undefined;
  private offset = 0;
  private readonly magic: Buffer;
  constructor(magic: Buffer) { this.magic = magic; }

  *push(chunk: Buffer): Generator<{command: string, payload: Buffer}> {
    let pos = 0;
    while (pos < chunk.length) {
      const target = this.payload ?? this.header;
      const count = chunk.copy(target, this.offset, pos, pos + target.length - this.offset);
      this.offset += count;
      pos += count;
      if (this.offset < target.length) break;
      if (!this.payload) {
        if (!this.header.subarray(0, 4).equals(this.magic)) throw new Error('Wrong Bitcoin network magic');
        const size = this.header.readUInt32LE(16);
        if (size > MAX_PAYLOAD) throw new Error('Peer message too large');
        this.payload = Buffer.allocUnsafe(size);
        this.offset = 0;
        if (size) continue;
      }
      const data = this.payload;
      this.payload = undefined;
      this.offset = 0;
      const name = this.header.subarray(4, 16).toString('latin1');
      if (!/^[\x20-\x7e]+\x00*$/.test(name) || !hash256(data).subarray(0, 4).equals(this.header.subarray(20))) continue;
      yield { command: name.replace(/\x00+$/, ''), payload: data };
    }
  }
}

export function versionMessage(height: number) {
  const nonce = randomBytes(8);
  const bytes = Buffer.concat([u32le(VERSION), i64le(8n), i64le(BigInt(Math.floor(Date.now() / 1000))),
    Buffer.alloc(52), nonce, varBytes(Buffer.from('/bitcoin-ts:0.1/')), u32le(height), Buffer.of(0)]);
  return { nonce, bytes };
}

export function checkVersion(payload: Buffer, nonce: Buffer) {
  const r = new Reader(payload);
  if (r.i32() < 31800) throw new Error('Peer protocol version is too old');
  r.read(8 + 8 + 26);
  if (r.offset < payload.length) {
    r.read(26);
    if (r.read(8).equals(nonce)) throw new Error('Peer connection is a self connection');
  }
  if (r.offset < payload.length && r.varBytes().length > 256) throw new Error('Peer user agent is too long');
  if (r.offset < payload.length) r.i32();
  if (r.offset < payload.length) r.u8();
}

export function readHeaders(payload: Buffer): Buffer[] {
  const r = new Reader(payload);
  const count = r.compact();
  if (count > 2000) throw new Error('Too many headers');
  const headers: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    headers.push(r.read(80));
    r.compact();
  }
  return headers;
}

export function writeHeaders(headers: Buffer[]): Buffer {
  return Buffer.concat([compactSize(headers.length), ...headers.flatMap(h => [h, Buffer.of(0)])]);
}

export function getHeaders(locator: string[], stop?: string): Buffer {
  return Buffer.concat([u32le(VERSION), compactSize(locator.length), ...locator.map(wireHash), stop ? wireHash(stop) : Buffer.alloc(32)]);
}

export function readLocator(payload: Buffer) {
  const r = new Reader(payload);
  r.u32();
  const size = r.compact();
  if (size > 101) throw new Error('Block locator too long');
  const locator = Array.from({length: size}, () => displayHash(r.read(32)));
  return { locator, stop: displayHash(r.read(32)) };
}

export function blockInventory(payload: Buffer): string[] {
  const r = new Reader(payload);
  const size = r.compact();
  if (size > 50000) throw new Error('Too many inventory entries');
  const blocks: string[] = [];
  for (let i = 0; i < size; i++) {
    const type = r.u32();
    const hash = r.read(32);
    if (type === 2 || type === WITNESS_BLOCK) blocks.push(displayHash(hash));
  }
  return blocks;
}

export function getBlocks(hashes: string[]) {
  return Buffer.concat([compactSize(hashes.length), ...hashes.flatMap(h => [u32le(WITNESS_BLOCK), wireHash(h)])]);
}
