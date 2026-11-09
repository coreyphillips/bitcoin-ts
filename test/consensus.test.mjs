import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Chain, Reader, parseTransaction, serializeTransaction, txid, displayHash, verifyScript } from '../dist/index.js';
import { harnessSession } from '../dist/harness.js';

const blocks = JSON.parse(readFileSync(new URL('./fixtures/regtest.json', import.meta.url)));

test('Core regtest blocks, UTXO fingerprints and invalidation', () => {
  const chain = new Chain('regtest');
  for (const [i, item] of blocks.entries()) {
    const result = chain.processBlock(Buffer.from(item.block, 'hex'), 1600000000, 'rpc');
    assert.equal(result.tip, item.hash);
    assert.equal(result.height, i + 1);
    assert.deepEqual(chain.utxoHash(), item.utxo);
  }
  assert.equal(chain.invalidate(blocks[1].hash).tip, blocks[0].hash);
  assert.deepEqual(chain.utxoHash(), blocks[0].utxo);
});

test('transaction round trip, witness txid and trailing bytes', () => {
  const wire = Buffer.from(blocks[0].block, 'hex').subarray(81);
  const tx = parseTransaction(wire);
  assert.deepEqual(serializeTransaction(tx), wire);
  const stripped = serializeTransaction(tx, false);
  assert.ok(stripped.length < wire.length);
  assert.deepEqual(txid(tx), createHash('sha256').update(createHash('sha256').update(stripped).digest()).digest());
  const spent = [{ script: Buffer.from([0x51]), value: 1n }];
  const spend = { ...tx, inputs: [{ ...tx.inputs[0], script: Buffer.alloc(0), witness: [] }] };
  assert.equal(verifyScript(spend, 0, spent, new Set()), 'OK');
  assert.equal(verifyScript(spend, 0, [{ ...spent[0], script: Buffer.from([0x00]) }], new Set()), 'EVAL_FALSE');
  assert.throws(() => parseTransaction(Buffer.concat([wire, Buffer.alloc(1)])));
  assert.throws(() => new Reader(Buffer.from('fdfc00', 'hex')).compact());
});

test('harness distinguishes malformed requests and consensus failures', async () => {
  const run = harnessSession();
  assert.equal((await run('{')).id, null);
  assert.equal((await run('{"op":"missing","id":3}')).error, 'unsupported_op');
  assert.equal((await run('{"op":"tx_check","id":4,"tx":"xy"}')).error, 'bad_request');
  assert.deepEqual(await run('{"op":"tx_check","id":5,"tx":"ff"}'), { id: 5, ok: true, valid: false, reason: 'tx-decode' });
  assert.equal((await run('{"op":"tx_check","id":6,"tx":"01000000000000000000"}')).reason, 'bad-txns-vin-empty');
  assert.equal(displayHash(Buffer.alloc(32)), '00'.repeat(32));
});

test('all five networks start with the specified genesis header', () => {
  const expected = {
    main: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    testnet3: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
    testnet4: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
    signet: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
    regtest: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
  };
  for (const [name, hash] of Object.entries(expected)) {
    const chain = new Chain(name);
    assert.equal(chain.tip().tip, hash);
    assert.equal(chain.utxoHash().txouts, 0);
  }
  assert.equal(new Chain('signet').params.magic.toString('hex'), '0a03cf40');
});
