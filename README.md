# bitcoin-ts

A Bitcoin consensus library and multi-peer validating node in TypeScript. It implements Bitcoin Consensus Specification `v32.1-1`, pinned to revision `a5ea54f4ec818db8e8a1ed2846d34509c85fbc6e`. The spec targets Bitcoin Core 32.1. [Specification](https://github.com/coreyphillips/bitcoin-consensus-spec/tree/a5ea54f4ec818db8e8a1ed2846d34509c85fbc6e)

## Run locally

Use Node.js 22.13 or newer and npm. From this directory, run

```sh
npm ci
npm test
node dist/cli.js status --network regtest
```

The status command prints the active block hash, height, cumulative work, UTXO count and UTXO fingerprint. On a fresh regtest database the height is zero and the tip is `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`. The test suite includes an end-to-end download and restart using a temporary loopback peer and private data directories.

## Connect and synchronize

Run the node from this directory to discover mainnet peers, maintain up to eight outbound connections, and download and validate blocks from genesis. Once caught up, it follows new blocks. It stores the chain under `./data/main`.

```sh
npm start
```

Use Ctrl+C to stop. Run `npm start` again to resume. To check the saved mainnet tip after stopping, run `node dist/cli.js status --network main`.

For a short first run, the following command discovers a public mainnet peer, validates block 1 and exits at that hash. Use a fresh data directory for this example.

```sh
node dist/cli.js sync --datadir ./data/first-block --stop-at 00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048
```

Discovery starts with cached peers and fills vacant slots using the network's IPv4 and IPv6 DNS seeds. The node validates headers from each peer and chooses chains by cumulative proof of work. Peers can deliver different blocks at the same time. Each block request has one owner and a deadline. When a peer disconnects or stalls, another peer advertising that branch can take over its outstanding requests.

`--max-peers N` sets the outbound connection limit from 1 to 16. Handshakes in progress count toward the limit. For example, to follow testnet4 with four connections, run

```sh
node dist/cli.js sync --network testnet4 --max-peers 4 --follow
```

Use `sync` for a one-time download. It waits for the connected peers' header replies and for the active chain to reach the best known header work. `--stop-at` exits as soon as the requested hash becomes the active tip. `--follow` keeps the pool running and fills vacancies as peers leave. A fresh mainnet sync downloads and stores the full block history.

Mainnet, testnet3, testnet4 and default signet support discovery. Regtest, a custom signet challenge, and modified activation heights require explicit peers. Repeat `--connect` to provide a fixed list. The node bypasses DNS, and extra endpoints above the connection limit serve as standbys. For example, if you operate two regtest peers on ports 28444 and 28445, run

```sh
node dist/cli.js sync --network regtest --connect 127.0.0.1:28444 --connect 127.0.0.1:28445 --follow
```

Explicit connections and the status command default to regtest when the network is omitted.

Available networks are `main`, `testnet3`, `testnet4`, `signet`, and `regtest`. For a custom network configuration, pass an options object, for example `--options '{"testactivationheight":{"segwit":120}}'` on regtest. Supply the same network and options each time you open that data directory.

Each directory contains its own `chain.sqlite`. A single transaction commits a block's validation state, undo data, active tip and UTXO changes together. Reopening reconstructs the header index and loads block bodies on demand. The node retains all accepted block bodies, undo data, and a header index for competing branches. Only one process can open a data directory at a time.

## Use the library

After building, another local project can install this checkout with `npm install /absolute/path/to/bitcoin-ts`. The package exports ESM and TypeScript declarations. The consensus library runs independently of any peer, Bitcoin Core process or Rust installation.

```ts
import { Chain, checkTransaction, displayHash, parseTransaction, txid } from 'bitcoin-ts';

const chain = new Chain('regtest');
console.log(chain.tip());

export function inspectTransaction(raw: Buffer) {
  const tx = parseTransaction(raw);
  return {
    id: displayHash(txid(tx)),
    rejection: checkTransaction(tx),
    satoshis: tx.outputs.map(output => output.value),
  };
}
```

`parseTransaction` requires complete canonical wire framing and throws on a decoding error. `checkTransaction` returns `null` on success or a context-free rejection reason. An input's spending authorization requires its spent outputs and the activation flags. `verifyScript(tx, index, spentOutputs, flags)` performs that check and returns `OK` or a Script error identifier. `Chain.processBlock` also checks spending against the current UTXO set, maturity, amounts, locktimes and subsidies.

The public API includes transaction and block decoding, legacy/SegWit/Taproot signature hashing, ECDSA and Schnorr verification, Merkle roots, Script execution through `verifyScript`, and in-memory chain selection. Amounts in the library use `bigint` satoshis. Hash functions return wire-order bytes. `displayHash` formats them for comparison with Bitcoin Core. For a disk-backed chain in an application, import `ChainStore` from `bitcoin-ts/node`. Call `await syncNetwork(store, { maxPeers: 8 })` for discovery, `await syncPeers(store, addresses)` for a fixed set, or `await syncPeer(store, address)` for one endpoint. All three functions are exported from `bitcoin-ts/node`. Pass an `AbortSignal` as the `signal` option to cancel a running sync. Close the store after the promise settles.

## Conformance

The upstream runner and vectors can be used directly against `node dist/cli.js harness`. To reproduce the default suites with strict error-code and fingerprint checks, run

```sh
npm run conformance
```

This requires Rust, Cargo, Git, and a sibling `bitcoin-consensus-spec` checkout containing the pinned commit. Set `BITCOIN_SPEC_DIR` to use another checkout. The script exports that revision to a temporary directory and builds the runner there. To run just the recorded block scenarios, use `npm run conformance -- --suite corpus`.

The eight vector suites cover 337,984 checks, including the flag combinations for Script, SegWit and Taproot, legacy signature hashes, BIP340, and BIP341. The 20 recorded Bitcoin Core block scenarios cover 5,275 normative active tips, 1,230 chain-tip sets, and 2,288 UTXO fingerprints. Each verdict, expected error identifier, recorded tip set and UTXO fingerprint matched. A separate disk-backed replay matched the corpus across 122 additional database close/reopen cycles. Three loopback peers shared the block downloads in each of the 20 scenarios. The final chain tips and UTXO fingerprints matched every recording. The future-dated mining scenario used its recorded clock. The bundled three-block fixture comes from the upstream `mining_basic.node0` regtest recording.

## Scope

This release targets consensus validation and block download. Wallets, key management, mining, mempool policy, transaction broadcasting, and inbound peer service are outside its scope. Live tests established three simultaneous connections to public mainnet peers and, in a separate run, validated mainnet through block 170. Full mainnet synchronization and the live Bitcoin Core interoperability suite remain unverified for this release.
