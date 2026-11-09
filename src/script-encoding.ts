/** Opcode bytes from specification chapter 04. */
export const Op = {
  "0": 0x00,
  "PUSHDATA1": 0x4c,
  "PUSHDATA2": 0x4d,
  "PUSHDATA4": 0x4e,
  "1NEGATE": 0x4f,
  "RESERVED": 0x50,
  "1": 0x51,
  "16": 0x60,
  "NOP": 0x61,
  "VER": 0x62,
  "IF": 0x63,
  "NOTIF": 0x64,
  "VERIF": 0x65,
  "VERNOTIF": 0x66,
  "ELSE": 0x67,
  "ENDIF": 0x68,
  "VERIFY": 0x69,
  "RETURN": 0x6a,
  "TOALTSTACK": 0x6b,
  "FROMALTSTACK": 0x6c,
  "2DROP": 0x6d,
  "2DUP": 0x6e,
  "3DUP": 0x6f,
  "2OVER": 0x70,
  "2ROT": 0x71,
  "2SWAP": 0x72,
  "IFDUP": 0x73,
  "DEPTH": 0x74,
  "DROP": 0x75,
  "DUP": 0x76,
  "NIP": 0x77,
  "OVER": 0x78,
  "PICK": 0x79,
  "ROLL": 0x7a,
  "ROT": 0x7b,
  "SWAP": 0x7c,
  "TUCK": 0x7d,
  "CAT": 0x7e,
  "SUBSTR": 0x7f,
  "LEFT": 0x80,
  "RIGHT": 0x81,
  "SIZE": 0x82,
  "INVERT": 0x83,
  "AND": 0x84,
  "OR": 0x85,
  "XOR": 0x86,
  "EQUAL": 0x87,
  "EQUALVERIFY": 0x88,
  "RESERVED1": 0x89,
  "RESERVED2": 0x8a,
  "1ADD": 0x8b,
  "1SUB": 0x8c,
  "2MUL": 0x8d,
  "2DIV": 0x8e,
  "NEGATE": 0x8f,
  "ABS": 0x90,
  "NOT": 0x91,
  "0NOTEQUAL": 0x92,
  "ADD": 0x93,
  "SUB": 0x94,
  "MUL": 0x95,
  "DIV": 0x96,
  "MOD": 0x97,
  "LSHIFT": 0x98,
  "RSHIFT": 0x99,
  "BOOLAND": 0x9a,
  "BOOLOR": 0x9b,
  "NUMEQUAL": 0x9c,
  "NUMEQUALVERIFY": 0x9d,
  "NUMNOTEQUAL": 0x9e,
  "LESSTHAN": 0x9f,
  "GREATERTHAN": 0xa0,
  "LESSTHANOREQUAL": 0xa1,
  "GREATERTHANOREQUAL": 0xa2,
  "MIN": 0xa3,
  "MAX": 0xa4,
  "WITHIN": 0xa5,
  "RIPEMD160": 0xa6,
  "SHA1": 0xa7,
  "SHA256": 0xa8,
  "HASH160": 0xa9,
  "HASH256": 0xaa,
  "CODESEPARATOR": 0xab,
  "CHECKSIG": 0xac,
  "CHECKSIGVERIFY": 0xad,
  "CHECKMULTISIG": 0xae,
  "CHECKMULTISIGVERIFY": 0xaf,
  "NOP1": 0xb0,
  "CHECKLOCKTIMEVERIFY": 0xb1,
  "CHECKSEQUENCEVERIFY": 0xb2,
  "NOP4": 0xb3,
  "NOP5": 0xb4,
  "NOP6": 0xb5,
  "NOP7": 0xb6,
  "NOP8": 0xb7,
  "NOP9": 0xb8,
  "NOP10": 0xb9,
  "CHECKSIGADD": 0xba,
  "INVALIDOPCODE": 0xff,
} as const;

const EMPTY = Buffer.alloc(0);
export class ScriptFailure extends Error {}
export function fail(error: string): never {
  throw new ScriptFailure(error);
}

export interface Cursor { offset: number }
export function readOp(script: Buffer, cursor: Cursor): { opcode: number; data: Buffer } | null {
  if (cursor.offset >= script.length) return null;
  const opcode = script[cursor.offset++];
  if (opcode > Op.PUSHDATA4) return { opcode, data: EMPTY };
  let size = opcode;
  if (opcode >= Op.PUSHDATA1) {
    const width = 2 ** (opcode - Op.PUSHDATA1);
    if (cursor.offset + width > script.length) return null;
    size = script.readUIntLE(cursor.offset, width);
    cursor.offset += width;
  }
  if (cursor.offset + size > script.length) return null;
  const start = cursor.offset;
  cursor.offset += size;
  return { opcode, data: script.subarray(start, cursor.offset) };
}

export function pushData(data: Buffer): Buffer {
  const size = data.length;
  if (size < Op.PUSHDATA1) return Buffer.concat([Buffer.from([size]), data]);
  const width = size <= 0xff ? 1 : size <= 0xffff ? 2 : 4;
  const prefix = Buffer.alloc(1 + width);
  prefix[0] = width === 1 ? Op.PUSHDATA1 : width === 2 ? Op.PUSHDATA2 : Op.PUSHDATA4;
  prefix.writeUIntLE(size, 1, width);
  return Buffer.concat([prefix, data]);
}

export function encodeScriptNumber(value: number): Buffer {
  if (!Number.isSafeInteger(value)) throw new RangeError('expected safe integer');
  if (value === 0) return EMPTY;
  let magnitude = Math.abs(value);
  const bytes: number[] = [];
  while (magnitude > 0) {
    bytes.push(magnitude % 256);
    magnitude = Math.floor(magnitude / 256);
  }
  if ((bytes[bytes.length - 1] & 0x80) !== 0) bytes.push(value < 0 ? 0x80 : 0);
  else if (value < 0) bytes[bytes.length - 1] |= 0x80;
  return Buffer.from(bytes);
}

export function pushScriptNumber(value: number): Buffer {
  if (value === -1 || (value >= 1 && value <= 16 && Number.isInteger(value))) {
    return Buffer.from([Op['1'] - 1 + value]);
  }
  return pushData(encodeScriptNumber(value));
}

export function scriptNumber(data: Buffer, maxSize = 4): number {
  if (data.length > maxSize) fail('SCRIPTNUM');
  if (data.length === 0) return 0;
  const last = data[data.length - 1];
  let magnitude = last & 0x7f;
  for (let i = data.length - 2; i >= 0; i--) magnitude = magnitude * 256 + data[i];
  return last & 0x80 ? -magnitude : magnitude;
}

export function scriptBool(data: Buffer): boolean {
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) return i !== data.length - 1 || data[i] !== 0x80;
  }
  return false;
}

export function isP2SH(script: Buffer): boolean {
  return script.length === 23 && script[0] === Op.HASH160 && script[1] === 20 && script[22] === Op.EQUAL;
}

export function witnessProgram(script: Buffer): { version: number; program: Buffer } | null {
  if (script.length < 4 || script.length > 42 || script.length !== script[1] + 2) return null;
  const opcode = script[0];
  if (opcode !== Op['0'] && (opcode < Op['1'] || opcode > Op['16'])) return null;
  return { version: opcode === 0 ? 0 : opcode - Op['1'] + 1, program: script.subarray(2) };
}

/** Returns null for a malformed or non-push-only script. */
export function lastPushedData(script: Buffer): Buffer | null {
  const cursor = { offset: 0 };
  let data: Buffer = EMPTY;
  while (cursor.offset < script.length) {
    const op = readOp(script, cursor);
    if (!op || op.opcode > Op['16']) return null;
    data = op.data;
  }
  return data;
}

/** Remove matching bytes only at opcode boundaries, keeping any malformed tail. */
export function findAndDelete(script: Buffer, pattern: Buffer): Buffer {
  if (pattern.length === 0) return script;
  const cursor = { offset: 0 };
  const parts: Buffer[] = [];
  let start = 0;
  while (cursor.offset < script.length) {
    if (script.subarray(cursor.offset, cursor.offset + pattern.length).equals(pattern)) {
      parts.push(script.subarray(start, cursor.offset));
      cursor.offset += pattern.length;
      start = cursor.offset;
    } else if (!readOp(script, cursor)) break;
  }
  if (!parts.length) return script;
  parts.push(script.subarray(start));
  return Buffer.concat(parts);
}

export function countSigOps(script: Buffer, accurate: boolean): number {
  let count = 0;
  let previous: number = Op.INVALIDOPCODE;
  const cursor = { offset: 0 };
  for (let op; (op = readOp(script, cursor)); previous = op.opcode) {
    if (op.opcode === Op.CHECKSIG || op.opcode === Op.CHECKSIGVERIFY) count++;
    if (op.opcode === Op.CHECKMULTISIG || op.opcode === Op.CHECKMULTISIGVERIFY) {
      count += accurate && previous >= Op['1'] && previous <= Op['16'] ? previous - Op['1'] + 1 : 20;
    }
  }
  return count;
}
