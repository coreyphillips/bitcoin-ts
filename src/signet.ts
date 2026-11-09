import { merkleRoot, witnessCommitmentIndex, type Block } from './block.js';
import { Reader } from './codec.js';
import { readOp, pushData } from './script-encoding.js';
import { verifyScript } from './script.js';
import { txid, type Transaction } from './tx.js';

const marker = Buffer.from('ecc7daa2', 'hex');
const flags = new Set(['P2SH', 'WITNESS', 'DERSIG', 'NULLDUMMY']);

function extractSolution(script: Buffer): { replacement: Buffer; solution: Buffer } | undefined {
  const cursor = { offset: 0 };
  const parts: Buffer[] = [];
  let solution: Buffer | undefined;
  for (let op; (op = readOp(script, cursor));) {
    if (!solution && op.data.length > 4 && op.data.subarray(0, 4).equals(marker)) {
      solution = op.data.subarray(4);
      parts.push(pushData(marker));
    } else {
      parts.push(op.data.length ? pushData(op.data) : Buffer.from([op.opcode]));
    }
  }
  if (solution) return { replacement: Buffer.concat(parts), solution };
}

export function validSignetSolution(block: Block, challenge: Buffer): boolean {
  const position = witnessCommitmentIndex(block);
  if (position < 0) return false;
  const coinbase = block.transactions[0];
  const output = coinbase.outputs[position];
  const section = extractSolution(output.script);
  let script: Buffer = Buffer.alloc(0);
  const witness: Buffer[] = [];
  const leaves = block.ids.slice();
  if (section) {
    const outputs = coinbase.outputs.slice();
    outputs[position] = { ...output, script: section.replacement };
    leaves[0] = txid({ ...coinbase, outputs });
    const reader = new Reader(section.solution);
    try {
      script = reader.varBytes();
      const count = reader.compact();
      for (let i = 0; i < count; i++) witness.push(reader.varBytes());
      if (reader.remaining) return false;
    } catch { return false; }
  }
  const header = block.header.raw;
  const data = Buffer.concat([header.subarray(0, 36), merkleRoot(leaves).root, header.subarray(68, 72)]);
  const toSpend: Transaction = {
    version: 0, locktime: 0, outputs: [{ value: 0n, script: challenge }],
    inputs: [{ hash: Buffer.alloc(32), index: 0xffffffff, sequence: 0, script: Buffer.concat([Buffer.from([0]), pushData(data)]), witness: [] }],
  };
  const toSign: Transaction = {
    version: 0, locktime: 0, outputs: [{ value: 0n, script: Buffer.from([0x6a]) }],
    inputs: [{ hash: txid(toSpend), index: 0, sequence: 0, script, witness }],
  };
  return verifyScript(toSign, 0, toSpend.outputs, flags) === 'OK';
}
