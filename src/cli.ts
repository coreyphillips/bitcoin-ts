#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hex, integer, networkName, networkOptions } from './input.js';

const help = `bitcoin-ts

  bitcoin-ts harness
  bitcoin-ts tx <serialized-transaction-hex>
  bitcoin-ts status [--network NAME] [--datadir PATH] [--options JSON]
  bitcoin-ts sync --connect HOST[:PORT] [--network NAME] [--datadir PATH]
                  [--stop-at HASH | --follow] [--timeout SECONDS] [--options JSON]

Networks: regtest (default), main, testnet3, testnet4, signet.
State defaults to ./data/<network>. Use the same options when reopening a directory.
Sync exits when caught up. --follow waits for announcements on the connected peer.
`;

async function main(args: string[]) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(help);
    return;
  }
  if (command === 'harness') {
    if (rest.length) throw new Error('harness takes no arguments');
    await (await import('./harness.js')).runHarness();
    return;
  }
  if (command === 'tx') {
    if (rest.length !== 1) throw new Error('Usage: bitcoin-ts tx <serialized-transaction-hex>');
    const { parseTransaction, txid, wtxid, checkTransaction, serializeTransaction } = await import('./tx.js');
    const { displayHash } = await import('./wire.js');
    const tx = parseTransaction(hex(rest[0], 'transaction'));
    const reason = checkTransaction(tx);
    const base = serializeTransaction(tx, false).length;
    const size = serializeTransaction(tx).length;
    console.log(JSON.stringify({
      txid: displayHash(txid(tx)), wtxid: displayHash(wtxid(tx)), size, weight: base * 3 + size,
      version: tx.version, locktime: tx.locktime, valid: reason === null, ...(reason ? { reason } : {}),
      inputs: tx.inputs.map(i => ({ txid: displayHash(i.hash), vout: i.index, scriptSig: i.script.toString('hex'),
        sequence: i.sequence, witness: i.witness.map(w => w.toString('hex')) })),
      outputs: tx.outputs.map(o => ({ satoshis: o.value.toString(), scriptPubKey: o.script.toString('hex') })),
    }, null, 2));
    return;
  }
  if (command !== 'sync' && command !== 'status') throw new Error(`Unknown command ${command}. Run bitcoin-ts --help`);
  const { values } = parseArgs({ args: rest, options: {
    network: { type: 'string', default: 'regtest' }, datadir: { type: 'string' },
    options: { type: 'string', default: '{}' }, connect: { type: 'string' },
    'stop-at': { type: 'string' }, follow: { type: 'boolean' }, timeout: { type: 'string' },
  }});
  const network = networkName(values.network);
  const opts = networkOptions(JSON.parse(values.options!), network);
  if (command === 'sync' && !values.connect) throw new Error('sync requires --connect HOST[:PORT]');
  if (command === 'status' && [values.connect, values['stop-at'], values.follow, values.timeout].some(x => x !== undefined)) {
    throw new Error('Connection options apply only to sync');
  }
  const stopAt = values['stop-at'] === undefined ? undefined : hex(values['stop-at'], 'stop-at', 32).toString('hex');
  if (stopAt && values.follow) throw new Error('Choose --stop-at or --follow');
  const timeout = integer(Number(values.timeout ?? 60), 'timeout seconds', 1, 86400) * 1000;
  const { ChainStore } = await import('./storage.js');
  const store = new ChainStore(resolve(values.datadir ?? `data/${network}`), network, opts);
  try {
    if (command === 'sync') {
      const { syncPeer } = await import('./peer.js');
      await syncPeer(store, values.connect!, { stopAt, follow: values.follow, timeout,
        onTip(hash, height) {
          if (values.follow || height % 1000 === 0) console.log(JSON.stringify({ event: 'tip', tip: hash, height }));
        },
      });
    }
    console.log(JSON.stringify({ ...(command === 'sync' ? { event: 'stopped' } : {}), network,
      ...store.chain.tip(), ...store.chain.utxoHash() }));
  } finally { store.close(); }
}
main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
