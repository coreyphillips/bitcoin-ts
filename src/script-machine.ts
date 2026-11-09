import { createHash } from 'node:crypto';
import { hash160, hash256, sha256 } from './codec.js';
import { verifyECDSA, verifySchnorr } from './crypto.js';
import { type SighashCache, legacySighash, taprootSighash, witnessV0Sighash } from './sighash.js';
import type { Transaction, TxOutput } from './tx.js';
import {
  Op, encodeScriptNumber, fail, findAndDelete, pushData, readOp, scriptBool, scriptNumber,
} from './script-encoding.js';

export type ScriptVersion = 'legacy' | 'witnessV0' | 'tapscript';
export interface Context {
  tx: Transaction;
  index: number;
  spent: TxOutput[];
  cache: SighashCache;
  flags: ReadonlySet<string>;
}

export interface TapContext {
  annex?: Buffer;
  leafHash?: Buffer;
  codeSeparator: number;
  budget: number;
}

export function newTapContext(): TapContext {
  return { codeSeparator: 0xffffffff, budget: 0 };
}

const disabled = new Set<number>([
  Op.CAT, Op.SUBSTR, Op.LEFT, Op.RIGHT, Op.INVERT, Op.AND, Op.OR, Op.XOR,
  Op['2MUL'], Op['2DIV'], Op.MUL, Op.DIV, Op.MOD, Op.LSHIFT, Op.RSHIFT,
]);

export function isOpSuccess(op: number): boolean {
  return disabled.has(op) || op === Op.RESERVED || op === Op.VER ||
    op === Op.RESERVED1 || op === Op.RESERVED2 || (op >= 187 && op <= 254);
}

function strictDER(sig: Buffer): boolean {
  // BIP66 includes the trailing hash type byte in its length checks.
  if (sig.length < 9 || sig.length > 73 || sig[0] !== 0x30 || sig[1] !== sig.length - 3) return false;
  const lenR = sig[3];
  if (lenR + 5 >= sig.length) return false;
  const lenS = sig[5 + lenR];
  if (lenR + lenS + 7 !== sig.length) return false;
  function integer(offset: number, length: number): boolean {
    return sig[offset] === 2 && length > 0 && (sig[offset + 2] & 0x80) === 0 &&
      !(length > 1 && sig[offset + 2] === 0 && (sig[offset + 3] & 0x80) === 0);
  }
  return integer(2, lenR) && integer(4 + lenR, lenS);
}

export function checkSchnorr(sig: Buffer, key: Buffer, ctx: Context, tap: TapContext): void {
  if (sig.length !== 64 && sig.length !== 65) fail('SCHNORR_SIG_SIZE');
  const hashType = sig.length === 65 ? sig[64] : 0;
  if (sig.length === 65 && hashType === 0) fail('SCHNORR_SIG_HASHTYPE');
  const digest = taprootSighash(ctx.tx, ctx.index, ctx.spent, hashType, tap.annex, tap.leafHash, tap.codeSeparator, ctx.cache);
  if (!digest) fail('SCHNORR_SIG_HASHTYPE');
  if (!verifySchnorr(key, digest, sig.subarray(0, 64))) fail('SCHNORR_SIG');
}

function checkTapSig(sig: Buffer, key: Buffer, ctx: Context, tap: TapContext): boolean {
  if (sig.length) {
    tap.budget -= 50;
    if (tap.budget < 0) fail('TAPSCRIPT_VALIDATION_WEIGHT');
  }
  if (!key.length) fail('TAPSCRIPT_EMPTY_PUBKEY');
  if (key.length === 32 && sig.length) checkSchnorr(sig, key, ctx, tap);
  return sig.length !== 0;
}

function checkECDSA(sig: Buffer, key: Buffer, scriptCode: Buffer, ctx: Context, version: ScriptVersion): boolean {
  if (!sig.length) return false;
  if (ctx.flags.has('DERSIG') && !strictDER(sig)) fail('SIG_DER');
  const hashType = sig[sig.length - 1];
  const amount = ctx.spent[ctx.index].value;
  if (version === 'witnessV0' && amount < 0n) return false;
  const digest = version === 'legacy'
    ? legacySighash(ctx.tx, ctx.index, scriptCode, hashType)
    : witnessV0Sighash(ctx.tx, ctx.index, scriptCode, amount, hashType, ctx.cache);
  return verifyECDSA(key, digest, sig.subarray(0, -1));
}

function checkLock(ctx: Context, value: number, relative: boolean): void {
  if (value < 0) fail('NEGATIVE_LOCKTIME');
  const sequence = ctx.tx.inputs[ctx.index].sequence;
  if (!relative) {
    if ((value < 500_000_000) !== (ctx.tx.locktime < 500_000_000) ||
        value > ctx.tx.locktime || sequence === 0xffffffff) fail('UNSATISFIED_LOCKTIME');
    return;
  }
  if (value & 0x80000000) return;
  const typeBit = 1 << 22;
  if ((ctx.tx.version >>> 0) < 2 || (sequence & 0x80000000) ||
      ((sequence ^ value) & typeBit) || (value & 0xffff) > (sequence & 0xffff)) {
    fail('UNSATISFIED_LOCKTIME');
  }
}

const unary = new Map<number, (n: number) => number>([
  [Op['1ADD'], n => n + 1], [Op['1SUB'], n => n - 1],
  [Op.NEGATE, n => -n], [Op.ABS, Math.abs],
  [Op.NOT, n => Number(n === 0)], [Op['0NOTEQUAL'], n => Number(n !== 0)],
]);
const binary = new Map<number, (a: number, b: number) => number>([
  [Op.ADD, (a, b) => a + b], [Op.SUB, (a, b) => a - b],
  [Op.BOOLAND, (a, b) => Number(Boolean(a && b))], [Op.BOOLOR, (a, b) => Number(Boolean(a || b))],
  [Op.NUMEQUAL, (a, b) => Number(a === b)], [Op.NUMEQUALVERIFY, (a, b) => Number(a === b)],
  [Op.NUMNOTEQUAL, (a, b) => Number(a !== b)], [Op.LESSTHAN, (a, b) => Number(a < b)],
  [Op.GREATERTHAN, (a, b) => Number(a > b)], [Op.LESSTHANOREQUAL, (a, b) => Number(a <= b)],
  [Op.GREATERTHANOREQUAL, (a, b) => Number(a >= b)], [Op.MIN, Math.min], [Op.MAX, Math.max],
]);

export function evalScript(
  stack: Buffer[], script: Buffer, ctx: Context, version: ScriptVersion, tap = newTapContext(),
): void {
  const tapscript = version === 'tapscript';
  if (!tapscript && script.length > 10_000) fail('SCRIPT_SIZE');
  const alt: Buffer[] = [];
  const cursor = { offset: 0 };
  let depth = 0;
  let firstFalse = -1;
  let codeStart = 0;
  let opCount = 0;
  tap.codeSeparator = 0xffffffff;

  function need(count: number): void {
    if (stack.length < count) fail('INVALID_STACK_OPERATION');
  }
  function top(distance = 1): Buffer {
    need(distance);
    return stack[stack.length - distance];
  }
  function pop(): Buffer {
    need(1);
    return stack.pop()!;
  }
  function result(value: boolean, verifyError?: string): void {
    if (verifyError) {
      if (!value) fail(verifyError);
    } else stack.push(encodeScriptNumber(Number(value)));
  }
  function multisig(opcode: number): void {
    if (tapscript) fail('TAPSCRIPT_CHECKMULTISIG');
    const keyCount = scriptNumber(pop());
    if (keyCount < 0 || keyCount > 20) fail('PUBKEY_COUNT');
    opCount += keyCount;
    if (opCount > 201) fail('OP_COUNT');
    need(keyCount + 1);
    const keys = stack.splice(stack.length - keyCount).reverse();
    const sigCount = scriptNumber(pop());
    if (sigCount < 0 || sigCount > keyCount) fail('SIG_COUNT');
    need(sigCount + 1);
    const signatures = stack.splice(stack.length - sigCount).reverse();
    let code = script.subarray(codeStart);
    if (version === 'legacy') {
      for (const sig of signatures) code = findAndDelete(code, pushData(sig));
    }
    let keyIndex = 0, sigIndex = 0;
    while (sigIndex < sigCount && sigCount - sigIndex <= keyCount - keyIndex) {
      if (checkECDSA(signatures[sigIndex], keys[keyIndex++], code, ctx, version)) sigIndex++;
    }
    if (pop().length && ctx.flags.has('NULLDUMMY')) fail('SIG_NULLDUMMY');
    result(sigIndex === sigCount, opcode === Op.CHECKMULTISIGVERIFY ? 'CHECKMULTISIGVERIFY' : undefined);
  }

  for (let position = 0; cursor.offset < script.length; position++) {
    const executing = firstFalse < 0;
    const op = readOp(script, cursor);
    if (!op) fail('BAD_OPCODE');
    const { opcode, data } = op;
    if (data.length > 520) fail('PUSH_SIZE');
    if (!tapscript && opcode > Op['16'] && ++opCount > 201) fail('OP_COUNT');
    if (disabled.has(opcode)) fail('DISABLED_OPCODE');

    if (executing && opcode <= Op.PUSHDATA4) stack.push(data);
    else if (executing && (opcode === Op['1NEGATE'] || (opcode >= Op['1'] && opcode <= Op['16']))) {
      stack.push(encodeScriptNumber(opcode - Op['1'] + 1));
    } else if (executing || (opcode >= Op.IF && opcode <= Op.ENDIF)) {
      switch (opcode) {
        case Op.NOP: case Op.NOP1: case Op.NOP4: case Op.NOP5: case Op.NOP6:
        case Op.NOP7: case Op.NOP8: case Op.NOP9: case Op.NOP10:
          break;
        case Op.CHECKLOCKTIMEVERIFY:
          if (ctx.flags.has('CHECKLOCKTIMEVERIFY')) checkLock(ctx, scriptNumber(top(), 5), false);
          break;
        case Op.CHECKSEQUENCEVERIFY:
          if (ctx.flags.has('CHECKSEQUENCEVERIFY')) checkLock(ctx, scriptNumber(top(), 5), true);
          break;
        case Op.IF: case Op.NOTIF: {
          if (executing) {
            const item = pop();
            if (tapscript && (item.length > 1 || (item.length === 1 && item[0] !== 1))) {
              fail('TAPSCRIPT_MINIMALIF');
            }
            if (scriptBool(item) === (opcode === Op.NOTIF)) firstFalse = depth;
          }
          depth++;
          break;
        }
        case Op.ELSE:
          if (!depth) fail('UNBALANCED_CONDITIONAL');
          if (firstFalse < 0) firstFalse = depth - 1;
          else if (firstFalse === depth - 1) firstFalse = -1;
          break;
        case Op.ENDIF:
          if (!depth) fail('UNBALANCED_CONDITIONAL');
          if (--depth === firstFalse) firstFalse = -1;
          break;
        case Op.VERIFY:
          if (!scriptBool(pop())) fail('VERIFY');
          break;
        case Op.RETURN: fail('OP_RETURN');
        case Op.TOALTSTACK: alt.push(pop()); break;
        case Op.FROMALTSTACK:
          if (!alt.length) fail('INVALID_ALTSTACK_OPERATION');
          stack.push(alt.pop()!);
          break;
        case Op['2DROP']: need(2); stack.length -= 2; break;
        case Op['2DUP']: stack.push(top(2), top()); break;
        case Op['3DUP']: stack.push(top(3), top(2), top()); break;
        case Op['2OVER']: stack.push(top(4), top(3)); break;
        case Op['2ROT']: need(6); stack.push(...stack.splice(-6, 2)); break;
        case Op['2SWAP']: need(4); stack.push(...stack.splice(-4, 2)); break;
        case Op.IFDUP: if (scriptBool(top())) stack.push(top()); break;
        case Op.DEPTH: stack.push(encodeScriptNumber(stack.length)); break;
        case Op.DROP: pop(); break;
        case Op.DUP: stack.push(top()); break;
        case Op.NIP: need(2); stack.splice(-2, 1); break;
        case Op.OVER: stack.push(top(2)); break;
        case Op.PICK: case Op.ROLL: {
          need(2);
          const distance = scriptNumber(pop());
          if (distance < 0 || distance >= stack.length) fail('INVALID_STACK_OPERATION');
          const item = top(distance + 1);
          if (opcode === Op.ROLL) stack.splice(-distance - 1, 1);
          stack.push(item);
          break;
        }
        case Op.ROT: need(3); stack.push(stack.splice(-3, 1)[0]); break;
        case Op.SWAP: need(2); stack.push(stack.splice(-2, 1)[0]); break;
        case Op.TUCK: need(2); stack.splice(-2, 0, top()); break;
        case Op.SIZE: stack.push(encodeScriptNumber(top().length)); break;
        case Op.EQUAL: case Op.EQUALVERIFY: {
          need(2);
          const equal = pop().equals(pop());
          result(equal, opcode === Op.EQUALVERIFY ? 'EQUALVERIFY' : undefined);
          break;
        }
        case Op.WITHIN: {
          need(3);
          const upper = scriptNumber(pop()), lower = scriptNumber(pop()), x = scriptNumber(pop());
          result(lower <= x && x < upper);
          break;
        }
        case Op.RIPEMD160: stack.push(createHash('ripemd160').update(pop()).digest()); break;
        case Op.SHA1: stack.push(createHash('sha1').update(pop()).digest()); break;
        case Op.SHA256: stack.push(sha256(pop())); break;
        case Op.HASH160: stack.push(hash160(pop())); break;
        case Op.HASH256: stack.push(hash256(pop())); break;
        case Op.CODESEPARATOR:
          codeStart = cursor.offset;
          tap.codeSeparator = position;
          break;
        case Op.CHECKSIG: case Op.CHECKSIGVERIFY: {
          need(2);
          const key = pop(), sig = pop();
          let valid: boolean;
          if (tapscript) valid = checkTapSig(sig, key, ctx, tap);
          else {
            let code = script.subarray(codeStart);
            if (version === 'legacy') code = findAndDelete(code, pushData(sig));
            valid = checkECDSA(sig, key, code, ctx, version);
          }
          result(valid, opcode === Op.CHECKSIGVERIFY ? 'CHECKSIGVERIFY' : undefined);
          break;
        }
        case Op.CHECKSIGADD: {
          if (!tapscript) fail('BAD_OPCODE');
          need(3);
          const key = pop(), value = scriptNumber(pop()), sig = pop();
          stack.push(encodeScriptNumber(value + Number(checkTapSig(sig, key, ctx, tap))));
          break;
        }
        case Op.CHECKMULTISIG: case Op.CHECKMULTISIGVERIFY: multisig(opcode); break;
        default: {
          const unaryOp = unary.get(opcode);
          if (unaryOp) {
            stack.push(encodeScriptNumber(unaryOp(scriptNumber(pop()))));
            break;
          }
          const binaryOp = binary.get(opcode);
          if (!binaryOp) fail('BAD_OPCODE');
          need(2);
          const b = scriptNumber(pop()), a = scriptNumber(pop());
          const value = binaryOp(a, b);
          if (opcode === Op.NUMEQUALVERIFY) result(value !== 0, 'NUMEQUALVERIFY');
          else stack.push(encodeScriptNumber(value));
        }
      }
    }
    if (stack.length + alt.length > 1000) fail('STACK_SIZE');
  }
  if (depth !== 0) fail('UNBALANCED_CONDITIONAL');
}
