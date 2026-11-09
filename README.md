# bitcoin-ts

A Bitcoin consensus library and single-peer validating node in TypeScript. It implements Bitcoin Consensus Specification `v32.1-1`, pinned to revision `a5ea54f4ec818db8e8a1ed2846d34509c85fbc6e`. The spec targets Bitcoin Core 32.1. [Specification](https://github.com/coreyphillips/bitcoin-consensus-spec/tree/a5ea54f4ec818db8e8a1ed2846d34509c85fbc6e)

## Run locally

Use Node.js 22.13 or newer and npm. From this directory, run

```sh
npm ci
npm test
node dist/cli.js status --network regtest
```

The status command prints the active block hash, height, cumulative work, UTXO count and UTXO fingerprint. On a fresh regtest database the height is zero and the tip is `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`. The test suite includes an end-to-end download and restart using a temporary loopback peer and private data directories.

## Synchronize from a peer

The node connects to the one Bitcoin v1 P2P endpoint you specify. Use a peer you trust to offer the best chain, and supply its P2P port. For example, to sync from a separate regtest peer listening on port 28444, run

```sh
node dist/cli.js sync --network regtest --connect 127.0.0.1:28444 --datadir ./data/regtest
node dist/cli.js status --network regtest --datadir ./data/regtest
```

The first command downloads headers and witness blocks, checks proof of work, validates transactions and scripts, and exits when caught up. Add `--follow` to keep the connection open for updates, or `--stop-at <block-hash>` to exit at a specific active tip. A stalled handshake or outstanding request times out after 60 seconds by default. After a disconnect, run the same command to resume.

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

The public API includes transaction and block decoding, legacy/SegWit/Taproot signature hashing, ECDSA and Schnorr verification, Merkle roots, Script execution through `verifyScript`, and in-memory chain selection. Amounts in the library use `bigint` satoshis. Hash functions return wire-order bytes. `displayHash` formats them for comparison with Bitcoin Core. For a disk-backed chain in an application, import `ChainStore` and `syncPeer` from `bitcoin-ts/node` and call `store.close()` when finished.

## Conformance

The upstream runner and vectors can be used directly against `node dist/cli.js harness`. To reproduce the default suites with strict error-code and fingerprint checks, run

```sh
npm run conformance
```

This requires Rust, Cargo, Git, and a sibling `bitcoin-consensus-spec` checkout containing the pinned commit. Set `BITCOIN_SPEC_DIR` to use another checkout. The script exports that revision to a temporary directory and builds the runner there. To run just the recorded block scenarios, use `npm run conformance -- --suite corpus`.

The eight vector suites cover 337,984 checks, including the flag combinations for Script, SegWit and Taproot, legacy signature hashes, BIP340, and BIP341. The 20 recorded Bitcoin Core block scenarios cover 5,275 normative active tips, 1,230 chain-tip sets, and 2,288 UTXO fingerprints. Each verdict, expected error identifier, recorded tip set and UTXO fingerprint matched. A separate disk-backed replay matched the corpus across 122 additional database close/reopen cycles. The peer downloader also matched all 20 final chains when served from loopback peers using the recorded block data. The future-dated mining scenario used its recorded clock. The bundled three-block fixture comes from the upstream `mining_basic.node0` regtest recording.

## Scope

This release targets consensus validation and block download. Wallets, key management, mining, mempool policy, transaction broadcasting, inbound peer service and peer discovery are outside its scope. Full mainnet synchronization, public-peer header synchronization and the live Bitcoin Core interoperability suite remain unverified for this release.
