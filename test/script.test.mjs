import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { countSigOps, pushData, transactionSigOpCost, verifyScript } from '../dist/script.js';

const hex = s => Buffer.from(s, 'hex');
const hash = (algorithm, data) => createHash(algorithm).update(data).digest();
const flags = new Set(['P2SH', 'WITNESS', 'DERSIG', 'TAPROOT']);

function spending(scriptSig = Buffer.alloc(0), witness = []) {
  return {
    version: 2, locktime: 0,
    inputs: [{ hash: Buffer.alloc(32, 7), index: 0, sequence: 3, script: scriptSig, witness }],
    outputs: [{ value: 99n, script: hex('51') }],
  };
}

test('redeem scripts and witness programs run with separate alternate stacks', () => {
  const script = hex('516b6c');
  const wsh = Buffer.concat([hex('0020'), hash('sha256', script)]);
  const p2sh = Buffer.concat([hex('a914'), hash('ripemd160', hash('sha256', wsh)), hex('87')]);
  const spent = [{ value: 100n, script: p2sh }];
  const tx = spending(pushData(wsh), [script]);
  assert.equal(verifyScript(tx, 0, spent, flags), 'OK');
  tx.inputs[0].script = Buffer.concat([hex('4c'), pushData(wsh)]);
  assert.equal(verifyScript(tx, 0, spent, flags), 'WITNESS_MALLEATED_P2SH');
  assert.equal(verifyScript(spending(hex('516b')), 0, [{ value: 100n, script: hex('6c') }], flags), 'INVALID_ALTSTACK_OPERATION');
});

test('sigop accounting skips push data and uses accurate counts in witness scripts', () => {
  // Push byte CHECKSIG, then OP_3 CHECKMULTISIG.
  const script = hex('01ac53ae');
  assert.equal(countSigOps(script, false), 20);
  assert.equal(countSigOps(script, true), 3);
  const tx = spending(Buffer.alloc(0), [script]);
  const spent = [{ value: 100n, script: Buffer.concat([hex('0020'), hash('sha256', script)]) }];
  assert.equal(transactionSigOpCost(tx, spent, flags), 3);
});

test('witness v0 cleanstack and legacy number overflow have distinct errors', () => {
  const script = hex('5151');
  const wsh = Buffer.concat([hex('0020'), hash('sha256', script)]);
  assert.equal(verifyScript(spending(Buffer.alloc(0), [script]), 0, [{ value: 1n, script: wsh }], flags), 'CLEANSTACK');
  // 0x7fffffff + 1 may be pushed but another arithmetic opcode cannot decode it.
  assert.equal(verifyScript(spending(), 0, [{ value: 1n, script: hex('04ffffff7f8b8b') }], flags), 'SCRIPTNUM');
});
