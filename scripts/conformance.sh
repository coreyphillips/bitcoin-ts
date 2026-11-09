#!/usr/bin/env bash
# Export the pinned specification into a temporary directory so its working tree stays untouched.
set -euo pipefail

project=$(cd "$(dirname "$0")/.." && pwd)
spec=${BITCOIN_SPEC_DIR:-"$project/../bitcoin-consensus-spec"}
revision=a5ea54f4ec818db8e8a1ed2846d34509c85fbc6e
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
git -C "$spec" archive "$revision" | tar -x -C "$scratch"
export CARGO_TARGET_DIR="$scratch/target"
cargo build --release --locked --manifest-path "$scratch/conformance/runner/Cargo.toml"

# The runner launches the harness with sh -c. Pass its path as an environment variable
# so checkouts with spaces or shell metacharacters work without interpolating shell code.
export BITCOIN_TS_HARNESS="$project/dist/cli.js"
"$CARGO_TARGET_DIR/release/bcs-conformance" --impl 'node "$BITCOIN_TS_HARNESS" harness' \
  --vectors "$scratch/conformance/vectors" --fail-on-level2 "$@"
