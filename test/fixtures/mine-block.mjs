import { hash256, merkleRoot, serializeTransaction, txid, wtxid } from '../../dist/index.js';
import { pushScriptNumber } from '../../dist/script.js';

export function mineBlock(parent, height, tag, spends = []) {
  const coinbase = {
    version: 1, locktime: 0,
    inputs: [{ hash: Buffer.alloc(32), index: 0xffffffff, sequence: 0xffffffff,
      script: Buffer.concat([pushScriptNumber(height), Buffer.of(tag)]), witness: [] }],
    outputs: [{ value: 5_000_000_000n, script: Buffer.of(0x51) }],
  };
  if (spends.some(tx => tx.inputs.some(input => input.witness.length))) {
    const reserved = Buffer.alloc(32);
    coinbase.inputs[0].witness = [reserved];
    const root = merkleRoot([Buffer.alloc(32), ...spends.map(wtxid)]).root;
    coinbase.outputs.push({ value: 0n, script: Buffer.concat([
      Buffer.from('6a24aa21a9ed', 'hex'), hash256(Buffer.concat([root, reserved])),
    ]) });
  }
  const txs = [coinbase, ...spends];
  const header = Buffer.alloc(80);
  header.writeInt32LE(4, 0);
  Buffer.from(parent, 'hex').reverse().copy(header, 4);
  merkleRoot(txs.map(txid)).root.copy(header, 36);
  header.writeUInt32LE(1_296_688_602 + height, 68);
  header.writeUInt32LE(0x207fffff, 72);
  const target = 0x7fffffn << 232n;
  for (let nonce = 0; ; nonce++) {
    header.writeUInt32LE(nonce, 76);
    const hash = hash256(header).reverse().toString('hex');
    if (BigInt('0x' + hash) <= target) {
      return { hash, coinbase, bytes: Buffer.concat([header, Buffer.of(txs.length),
        ...txs.map(tx => serializeTransaction(tx))]) };
    }
  }
}
