#!/usr/bin/env bash
#
# Builds and deploys the arena program.
#
# Exists because the SBPF version is not a free choice and the default is wrong
# for at least one cluster we target. `cargo build-sbf` emits SBPFv0 unless told
# otherwise, and clusters disagree about what they accept:
#
#   - A recent local validator has SIMD-0500 ("Disable deployment of SBPF v0, v1
#     and v2 programs") ACTIVE, so a v0 build is rejected with the memorably
#     unhelpful pair "Detected sbpf_version required by the executable which are
#     not enabled" and "invalid account data for instruction".
#   - devnet currently has SIMD-0500 INACTIVE, so v0 still deploys there.
#
# So the right arch depends on the target, and this asks the cluster rather than
# hardcoding an answer that will rot the next time a feature activates.
#
# Usage: scripts/deploy-program.sh [rpc-url]
#        scripts/deploy-program.sh                       # devnet
#        scripts/deploy-program.sh http://127.0.0.1:8899 # local validator
set -euo pipefail

RPC="${1:-https://api.devnet.solana.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYPAIR="$ROOT/.localdev/keys/authority.json"
PROGRAM_KEYPAIR="$ROOT/programs/target/deploy/arena-keypair.json"
SO="$ROOT/programs/target/deploy/arena.so"

# The feature gate that forbids v0/v1/v2 deployment.
SIMD_0500=B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g

if [ ! -f "$KEYPAIR" ]; then
  echo "No deployer keypair at $KEYPAIR" >&2
  echo "Create one with: solana-keygen new --outfile $KEYPAIR" >&2
  exit 1
fi

echo "Cluster: $RPC"

if solana feature status "$SIMD_0500" --url "$RPC" 2>/dev/null | grep -qi "active since"; then
  ARCH=v3
  echo "  SIMD-0500 active — legacy SBPF is refused, building v3"
else
  ARCH=v0
  echo "  SIMD-0500 inactive — building v0 for the widest execution support"
fi

# Forced, because cargo caches on source changes alone and will happily hand
# back an artifact built for a different architecture. That produced a build
# reporting success while deploying the *previous* arch, which is a confusing
# thing to debug.
rm -f "$SO" "$ROOT/programs/target/sbpf-solana-solana/release/arena.so"
touch "$ROOT/programs/programs/arena/src/lib.rs"

echo "Building (--arch $ARCH)..."
(cd "$ROOT/programs" && cargo build-sbf --arch "$ARCH" >/dev/null)

FLAGS=$(python3 -c "
import struct,sys
print(struct.unpack_from('<I', open('$SO','rb').read(64), 48)[0])
")
echo "  built $(wc -c < "$SO" | tr -d ' ') bytes, ELF e_flags=$FLAGS"

BALANCE=$(solana balance --keypair "$KEYPAIR" --url "$RPC" 2>/dev/null | awk '{print $1}')
echo "  deployer $(solana-keygen pubkey "$KEYPAIR") holds ${BALANCE:-0} SOL"

# Roughly 2x the program size in rent, plus fees.
echo "Deploying..."
solana program deploy "$SO" \
  --program-id "$PROGRAM_KEYPAIR" \
  --keypair "$KEYPAIR" \
  --url "$RPC"

echo
echo "Deployed. Initialise the config next:"
echo "  SOLANA_RPC_URL=$RPC pnpm onchain-check"
