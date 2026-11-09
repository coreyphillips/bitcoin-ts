#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hex, integer, networkName, networkOptions } from './input.js';
import { DEFAULT_MAX_PEERS, MAX_PEERS, syncPeers } from './pool.js';
import { DEFAULT_SCRIPT_THREADS, MAX_SCRIPT_THREADS } from './script-pool.js';

const help = `bitcoin-ts

  bitcoin-ts                  Discover mainnet peers, sync and follow the chain
  bitcoin-ts harness
  bitcoin-ts tx <serialized-transaction-hex>
  bitcoin-ts status [--network NAME] [--datadir PATH] [--options JSON]
  bitcoin-ts sync [--connect HOST[:PORT]]... [--max-peers N] [--network NAME] [--datadir PATH]
                  [--script-threads N] [--stop-at HASH | --follow] [--timeout SECONDS] [--options JSON]

Networks: main, testnet3, testnet4, signet, regtest.
Automatic sync defaults to main. Status and explicit --connect default to regtest.
State defaults to ./data/<network>. Use the same options when reopening a directory.
Public networks discover peers automatically. Regtest and custom networks require --connect.
Sync maintains up to ${DEFAULT_MAX_PEERS} outbound peers by default. Use --max-peers 1..${MAX_PEERS} to set the limit.
Repeat --connect to use a fixed set of peers. --follow keeps following the chain after sync.
Set --script-threads 1..${MAX_SCRIPT_THREADS} to choose the verification thread count. The default here is ${DEFAULT_SCRIPT_THREADS}.
`;

async function main(args: string[]) {
  const [command, ...rest] = args.length ? args : ['sync', '--follow'];
  if (command === '--help' || command === '-h' || command === 'help') {
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
    network: { type: 'string' }, datadir: { type: 'string' },
    options: { type: 'string', default: '{}' }, connect: { type: 'string', multiple: true }, 'max-peers': { type: 'string' },
    'stop-at': { type: 'string' }, follow: { type: 'boolean' }, timeout: { type: 'string' },
    'script-threads': { type: 'string' },
  }});
  const automatic = command === 'sync' && values.connect === undefined;
  const network = networkName(values.network ?? (automatic ? 'main' : 'regtest'));
  const opts = networkOptions(JSON.parse(values.options!), network);
  const syncOnly = [values.connect, values['stop-at'], values.follow, values.timeout, values['max-peers'], values['script-threads']];
  if (command === 'status' && syncOnly.some(x => x !== undefined)) {
    throw new Error('Peer and verification options apply only to sync');
  }
  const scriptThreads = values['script-threads'] === undefined ? undefined
    : integer(Number(values['script-threads']), 'script-threads', 1, MAX_SCRIPT_THREADS);
  const maxPeers = integer(Number(values['max-peers'] ?? DEFAULT_MAX_PEERS), 'max-peers', 1, MAX_PEERS);
  const stopAt = values['stop-at'] === undefined ? undefined : hex(values['stop-at'], 'stop-at', 32).toString('hex');
  if (stopAt && values.follow) throw new Error('Choose --stop-at or --follow');
  const timeout = integer(Number(values.timeout ?? 60), 'timeout seconds', 1, 86400) * 1000;
  if (automatic) {
    const { requireSeedHosts } = await import('./seeds.js');
    const { networkParams } = await import('./params.js');
    requireSeedHosts(networkParams(network, opts));
  }
  const { ChainStore } = await import('./storage.js');
  const store = new ChainStore(resolve(values.datadir ?? `data/${network}`), network, opts, { scriptThreads });
  try {
    if (command === 'sync') {
      const syncOptions = { stopAt, follow: values.follow, timeout,
        onTip(hash: string, height: number) {
          if (height === 1 || height % 1000 === 0 || (values.follow && height === store.chain.bestHeader().height)) {
            console.log(JSON.stringify({ event: 'tip', tip: hash, height }));
          }
        },
      };
      const connected = new Set<string>();
      const poolOptions = {
        ...syncOptions, maxPeers,
        onPeer(address: string, state: 'connecting' | 'ready' | 'failed', reason?: string) {
          if (state === 'ready') connected.add(address);
          if (state === 'failed') connected.delete(address);
          const count = state === 'connecting' ? '' : ` (${connected.size} connected)`;
          console.error(`Peer ${address} ${state}${count}${reason ? ': ' + reason : ''}`);
        },
        onRetry(delay: number, reason: string) {
          console.error(`${reason}. Retrying peers in ${delay / 1000}s`);
        },
      };
      if (automatic) {
        const { syncNetwork } = await import('./discovery.js');
        await syncNetwork(store, poolOptions);
      } else {
        await syncPeers(store, values.connect!, poolOptions);
      }
    }
    console.log(JSON.stringify({ ...(command === 'sync' ? { event: 'stopped' } : {}), network,
      ...store.chain.tip(), ...store.chain.utxoHash() }));
  } finally { store.close(); }
}
main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
