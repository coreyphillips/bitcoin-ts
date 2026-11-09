import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Reader, taggedHash, varBytes } from './codec.js';

const Point = secp256k1.Point;

/** Read an unsigned R or S with the historical lax DER length and padding rules. */
function derInteger(reader: Reader): Buffer {
  if (reader.u8() !== 2) throw new Error('invalid integer tag');
  let length = reader.u8();
  if ((length & 0x80) !== 0) {
    const encoded = reader.read(length & 0x7f);
    let start = 0;
    while (start < encoded.length && encoded[start] === 0) start++;
    const width = encoded.length - start;
    if (width >= 4) throw new Error('invalid integer length');
    length = width === 0 ? 0 : encoded.readUIntBE(start, width);
  }
  const data = reader.read(length);
  let start = 0;
  while (start < data.length && data[start] === 0) start++;
  const magnitude = data.subarray(start);
  if (magnitude.length > 32) throw new Error('invalid scalar');
  const padded = Buffer.alloc(32);
  magnitude.copy(padded, 32 - magnitude.length);
  return padded;
}

/** Bitcoin verifies high-S signatures, hybrid keys, and historical DER encodings. */
export function verifyECDSA(pubkey: Buffer, msg32: Buffer, derWithoutType: Buffer): boolean {
  if (msg32.length !== 32) return false;
  const prefix = pubkey[0];
  let key = pubkey;
  if (prefix === 2 || prefix === 3) {
    if (key.length !== 33) return false;
  } else if (prefix === 4 || prefix === 6 || prefix === 7) {
    if (key.length !== 65) return false;
    if (prefix !== 4) {
      if ((key[64] & 1) !== (prefix & 1)) return false;
      key = Buffer.from(key);
      key[0] = 4;
    }
  } else {
    return false;
  }
  try {
    const der = new Reader(derWithoutType);
    if (der.u8() !== 0x30) return false;
    const length = der.u8();
    if ((length & 0x80) !== 0) der.read(length & 0x7f);
    const compact = Buffer.concat([derInteger(der), derInteger(der)]);
    return secp256k1.verify(compact, msg32, key, { prehash: false, lowS: false, format: 'compact' });
  } catch {
    return false;
  }
}

function bigEndian(bytes: Buffer): bigint {
  return BigInt('0x' + bytes.toString('hex'));
}

function liftX(x: Buffer) {
  return Point.fromBytes(Buffer.concat([Buffer.from([2]), x]));
}

/** BIP340's challenge commits to the field element r, the public key and the entire message. */
export function verifySchnorr(pubkey: Buffer, msg: Buffer, sig: Buffer): boolean {
  if (pubkey.length !== 32 || sig.length !== 64) return false;
  const r = bigEndian(sig.subarray(0, 32));
  const s = bigEndian(sig.subarray(32));
  if (r >= Point.Fp.ORDER || s >= Point.Fn.ORDER) return false;
  try {
    const publicPoint = liftX(pubkey);
    const hash = taggedHash('BIP0340/challenge', Buffer.concat([sig.subarray(0, 32), pubkey, msg]));
    const challenge = bigEndian(hash) % Point.Fn.ORDER;
    const nonce = Point.BASE.multiplyUnsafe(s).subtract(publicPoint.multiplyUnsafe(challenge));
    if (nonce.is0()) return false;
    const { x, y } = nonce.toAffine();
    return (y & 1n) === 0n && x === r;
  } catch {
    return false;
  }
}

export function tapLeafHash(leafVersion: number, script: Buffer): Buffer {
  return taggedHash('TapLeaf', Buffer.concat([Buffer.from([leafVersion]), varBytes(script)]));
}

export function verifyTaprootCommitment(control: Buffer, script: Buffer, outputKey: Buffer): boolean {
  if (outputKey.length !== 32 || control.length < 33 || control.length > 33 + 32 * 128) return false;
  if ((control.length - 33) % 32 !== 0) return false;
  const internalKey = control.subarray(1, 33);
  let root = tapLeafHash(control[0] & 0xfe, script);
  for (let pos = 33; pos < control.length; pos += 32) {
    const sibling = control.subarray(pos, pos + 32);
    const branch = root.compare(sibling) < 0 ? [root, sibling] : [sibling, root];
    root = taggedHash('TapBranch', Buffer.concat(branch));
  }
  try {
    const tweak = bigEndian(taggedHash('TapTweak', Buffer.concat([internalKey, root])));
    if (tweak >= Point.Fn.ORDER) return false;
    const output = liftX(internalKey).add(Point.BASE.multiplyUnsafe(tweak));
    if (output.is0()) return false;
    const { x, y } = output.toAffine();
    return x === bigEndian(outputKey) && Number(y & 1n) === (control[0] & 1);
  } catch {
    return false;
  }
}
