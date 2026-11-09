import { compactSize, sha256 } from './codec.js';
import { tapLeafHash, verifyTaprootCommitment } from './crypto.js';
import { isCoinbase, type Transaction, type TxOutput } from './tx.js';
import { SighashCache } from './sighash.js';
import {
  Op, ScriptFailure, countSigOps, fail, isP2SH, lastPushedData, pushData, readOp, scriptBool, witnessProgram,
} from './script-encoding.js';
import {
  checkSchnorr, evalScript, isOpSuccess, newTapContext, type Context, type TapContext,
} from './script-machine.js';

export { countSigOps, encodeScriptNumber, pushScriptNumber, pushData } from './script-encoding.js';

function requireTrue(stack: Buffer[]): void {
  if (!stack.length || !scriptBool(stack[stack.length - 1])) fail('EVAL_FALSE');
}

function executeWitness(
  stack: Buffer[], script: Buffer, ctx: Context, version: 'witnessV0' | 'tapscript', tap: TapContext,
): void {
  if (version === 'tapscript') {
    const cursor = { offset: 0 };
    while (cursor.offset < script.length) {
      const op = readOp(script, cursor);
      if (!op) fail('BAD_OPCODE');
      if (isOpSuccess(op.opcode)) return;
    }
    if (stack.length > 1000) fail('STACK_SIZE');
  }
  if (stack.some(item => item.length > 520)) fail('PUSH_SIZE');
  evalScript(stack, script, ctx, version, tap);
  if (stack.length !== 1) fail('CLEANSTACK');
  requireTrue(stack);
}

function verifyWitness(
  version: number, program: Buffer, witness: Buffer[], ctx: Context, wrapped: boolean,
): void {
  const tap = newTapContext();
  if (version === 0) {
    let script: Buffer;
    const stack = witness.slice();
    if (program.length === 32) {
      if (!stack.length) fail('WITNESS_PROGRAM_WITNESS_EMPTY');
      script = stack.pop()!;
      if (!sha256(script).equals(program)) fail('WITNESS_PROGRAM_MISMATCH');
    } else if (program.length === 20) {
      if (witness.length !== 2) fail('WITNESS_PROGRAM_MISMATCH');
      script = Buffer.concat([
        Buffer.from([Op.DUP, Op.HASH160, 20]), program, Buffer.from([Op.EQUALVERIFY, Op.CHECKSIG]),
      ]);
    } else fail('WITNESS_PROGRAM_WRONG_LENGTH');
    executeWitness(stack, script, ctx, 'witnessV0', tap);
    return;
  }
  if (version !== 1 || program.length !== 32 || wrapped || !ctx.flags.has('TAPROOT')) return;
  if (!witness.length) fail('WITNESS_PROGRAM_WITNESS_EMPTY');
  const stack = witness.slice();
  if (stack.length >= 2 && stack[stack.length - 1][0] === 0x50) tap.annex = stack.pop()!;
  if (stack.length === 1) {
    checkSchnorr(stack[0], program, ctx, tap);
    return;
  }
  const control = stack.pop()!, script = stack.pop()!;
  if (control.length < 33 || control.length > 33 + 32 * 128 || (control.length - 33) % 32 !== 0) {
    fail('TAPROOT_WRONG_CONTROL_SIZE');
  }
  if (!verifyTaprootCommitment(control, script, program)) fail('WITNESS_PROGRAM_MISMATCH');
  const leafVersion = control[0] & 0xfe;
  if (leafVersion !== 0xc0) return;
  tap.leafHash = tapLeafHash(leafVersion, script);
  tap.budget = 50 + compactSize(witness.length).length;
  for (const item of witness) tap.budget += compactSize(item.length).length + item.length;
  executeWitness(stack, script, ctx, 'tapscript', tap);
}

/** Verify one transaction input with the flags active at its spending block. */
export function verifyScript(
  tx: Transaction, index: number, spent: TxOutput[], flags: ReadonlySet<string>, cache?: SighashCache,
): string {
  if (!Number.isInteger(index) || index < 0 || index >= tx.inputs.length || spent.length !== tx.inputs.length) {
    throw new RangeError('invalid input index or spent output count');
  }
  if (flags.has('WITNESS') && !flags.has('P2SH')) throw new RangeError('WITNESS requires P2SH');
  const ctx: Context = { tx, index, spent, flags, cache: cache ?? new SighashCache(tx, spent) };
  const input = tx.inputs[index], output = spent[index];
  try {
    const stack: Buffer[] = [];
    evalScript(stack, input.script, ctx, 'legacy');
    const p2sh = flags.has('P2SH') && isP2SH(output.script);
    const redeemStack = p2sh ? stack.slice() : [];
    evalScript(stack, output.script, ctx, 'legacy');
    requireTrue(stack);

    let candidate = output.script;
    if (p2sh) {
      if (!lastPushedData(input.script)) fail('SIG_PUSHONLY');
      candidate = redeemStack.pop()!;
      evalScript(redeemStack, candidate, ctx, 'legacy');
      requireTrue(redeemStack);
    }
    if (flags.has('WITNESS')) {
      const program = witnessProgram(candidate);
      if (program) {
        if (p2sh && !pushData(candidate).equals(input.script)) fail('WITNESS_MALLEATED_P2SH');
        if (!p2sh && input.script.length) fail('WITNESS_MALLEATED');
        verifyWitness(program.version, program.program, input.witness, ctx, p2sh);
      } else if (input.witness.length) fail('WITNESS_UNEXPECTED');
    }
    return 'OK';
  } catch (err) {
    if (err instanceof ScriptFailure) return err.message;
    throw err;
  }
}

export function transactionSigOpCost(tx: Transaction, spent: TxOutput[], flags: ReadonlySet<string>): number {
  let cost = 0;
  for (const input of tx.inputs) cost += 4 * countSigOps(input.script, false);
  for (const output of tx.outputs) cost += 4 * countSigOps(output.script, false);
  if (isCoinbase(tx)) return cost;
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i], script = spent[i].script;
    let candidate = script;
    if (isP2SH(script)) {
      const redeem = lastPushedData(input.script);
      if (!redeem) continue;
      if (flags.has('P2SH')) cost += 4 * countSigOps(redeem, true);
      candidate = redeem;
    }
    if (!flags.has('WITNESS')) continue;
    const witness = witnessProgram(candidate);
    if (witness?.version !== 0) continue;
    if (witness.program.length === 20) cost++;
    else if (witness.program.length === 32 && input.witness.length) {
      cost += countSigOps(input.witness[input.witness.length - 1], true);
    }
  }
  return cost;
}
