import { Reader, compactSize, hash256 } from './codec.js';
import { checkTransaction, isCoinbase, isFinalTx, readTransaction, strippedSize, txid, wtxid, type Transaction } from './tx.js';
import { countSigOps, pushScriptNumber } from './script-encoding.js';
import type { NetworkParams } from './params.js';
import { BlockFailure, parseHeader, validProof, type Header } from './pow.js';
import { validSignetSolution } from './signet.js';

export interface Block {
  header: Header;
  transactions: Transaction[];
  ids: Buffer[];
  stripped: number;
  total: number;
}

export function parseBlock(bytes: Buffer): Block {
  const reader = new Reader(bytes);
  // Header indexes outlive the received payload. Keep only its 80 header bytes.
  const header = parseHeader(Buffer.from(reader.read(80)));
  const count = reader.compact();
  if (count > Math.floor(reader.remaining / 10)) throw new Error('end of data');
  const transactions: Transaction[] = [];
  const ids: Buffer[] = [];
  let stripped = 80 + compactSize(count).length;
  for (let i = 0; i < count; i++) {
    const tx = readTransaction(reader);
    transactions.push(tx);
    ids.push(txid(tx));
    stripped += strippedSize(tx);
  }
  // Core ignores bytes following the last transaction.
  return { header, transactions, ids, stripped, total: reader.offset };
}

export function merkleRoot(leaves: Buffer[]): { root: Buffer; mutated: boolean } {
  let level = leaves;
  let mutated = false;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1];
      if (right && level[i].equals(right)) mutated = true;
      next.push(hash256(Buffer.concat([level[i], right ?? level[i]])));
    }
    level = next;
  }
  return { root: level[0] ?? Buffer.alloc(32), mutated };
}

const commitmentPrefix = Buffer.from('6a24aa21a9ed', 'hex');

export function witnessCommitmentIndex(block: Block): number {
  const outputs = block.transactions[0]?.outputs ?? [];
  for (let i = outputs.length - 1; i >= 0; i--) {
    const script = outputs[i].script;
    if (script.length >= 38 && script.subarray(0, 6).equals(commitmentPrefix)) return i;
  }
  return -1;
}

function witnessError(block: Block, active: boolean): string | null {
  const index = active ? witnessCommitmentIndex(block) : -1;
  if (index >= 0) {
    const coinbase = block.transactions[0];
    const stack = coinbase.inputs[0]?.witness;
    if (stack?.length !== 1 || stack[0].length !== 32) return 'bad-witness-nonce-size';
    const root = merkleRoot([Buffer.alloc(32), ...block.transactions.slice(1).map(wtxid)]).root;
    const commitment = hash256(Buffer.concat([root, stack[0]]));
    if (!commitment.equals(coinbase.outputs[index].script.subarray(6, 38))) return 'bad-witness-merkle-match';
  } else if (block.transactions.some(tx => tx.inputs.some(input => input.witness.length))) return 'unexpected-witness';
  return null;
}

/** Return the remaining contextual checks for this exact block after basic validation succeeds. */
export function checkBlock(block: Block, params: NetworkParams, genesis: string, peerSegwit?: boolean) {
  const { root, mutated } = merkleRoot(block.ids);
  const coinbase = block.transactions[0];
  if (peerSegwit !== undefined) {
    const corrupt = !coinbase || !isCoinbase(coinbase)
      ? block.transactions.some(tx => strippedSize(tx) === 64)
      : !!witnessError(block, peerSegwit);
    if (!root.equals(block.header.merkle) || mutated || corrupt) throw new BlockFailure('mutated', 'block-mutated');
  }
  if (!validProof(block.header, params.powLimit)) throw new BlockFailure('invalid', 'high-hash');
  if (params.challenge && block.header.hash !== genesis && !validSignetSolution(block, params.challenge)) {
    throw new BlockFailure('invalid', 'bad-signet-blksig');
  }
  if (!root.equals(block.header.merkle)) throw new BlockFailure('mutated', 'bad-txnmrklroot');
  if (mutated) throw new BlockFailure('mutated', 'bad-txns-duplicate');
  if (!coinbase || block.transactions.length > 1000000 || block.stripped > 1000000) throw new BlockFailure('invalid', 'bad-blk-length');
  if (!isCoinbase(coinbase)) throw new BlockFailure('invalid', 'bad-cb-missing');
  if (block.transactions.some((tx, index) => index > 0 && isCoinbase(tx))) throw new BlockFailure('invalid', 'bad-cb-multiple');
  let sigops = 0;
  for (const tx of block.transactions) {
    const reason = checkTransaction(tx);
    if (reason) throw new BlockFailure('invalid', reason);
    for (const input of tx.inputs) sigops += countSigOps(input.script, false);
    for (const output of tx.outputs) sigops += countSigOps(output.script, false);
  }
  if (sigops > 20000) throw new BlockFailure('invalid', 'bad-blk-sigops');
  return (height: number, parentMtp: number) => checkBlockContext(block, height, parentMtp, params, peerSegwit);
}

function checkBlockContext(block: Block, height: number, parentMtp: number, params: NetworkParams, checkedSegwit?: boolean): void {
  const cutoff = height >= params.heights.csv ? parentMtp : block.header.time;
  if (block.transactions.some(tx => !isFinalTx(tx, height, cutoff))) throw new BlockFailure('invalid', 'bad-txns-nonfinal');
  if (height >= params.heights.bip34) {
    const prefix = pushScriptNumber(height);
    if (!block.transactions[0].inputs[0].script.subarray(0, prefix.length).equals(prefix)) throw new BlockFailure('invalid', 'bad-cb-height');
  }
  const active = height >= params.heights.segwit;
  if (checkedSegwit !== active) {
    const reason = witnessError(block, active);
    if (reason) throw new BlockFailure('mutated', reason);
  }
  if (block.stripped * 3 + block.total > 4000000) throw new BlockFailure('invalid', 'bad-blk-weight');
}
