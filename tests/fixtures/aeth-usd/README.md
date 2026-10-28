# Mainnet aETH/aUSD native fixtures

`transactions.json` contains deterministic, unsigned buy/sell transactions built
from prop-amm's `minting` revision
`dfdbc9a36646066cbec067fa9e9a700232804855` using Arch SDK/program `0.12.0`:

- Buy: `server/src/treasury_mint.rs::buy_instructions` emits an APL transfer
  (tag 3, 9 bytes, 3 accounts), then bridge `MintFromTreasury` (tag 21,
  73 bytes, 11 accounts). The second signer is the treasury authority.
- Sell: `program/src/instruction.rs::execute_trade_instruction` emits compact
  `ExecuteTrade` (tag 2, side 1, 50 bytes including `min_out`, 13 accounts).
  The second signer is the PropAMM quote signer.

`generate.rs` calls these Rust builders, their native PDA helpers and
`ArchMessage::new`; the TypeScript tests decode and reserialize their original
bytes. The standalone exporter supplies only the server error type needed to
compile `treasury_mint.rs` outside the server binary.

Mainnet program/mint identities are real. The user, blockhash, mint ID, quote
amounts and time are test values. No private keys or signatures are included.
The fixed clock is `1800000000000` ms and expiry is 30 seconds later. These
fixtures are for offline ABI tests, not transaction submission.

At an illustrative price of 2,500 aUSD per aETH, the buy spends 1 aUSD for
400 aETH base units; the sell spends 1,000 aETH base units for 2.5 aUSD, with
a 1% output minimum. Both tokens have 6 decimals. Amount strings represent
integer base units, and `signed_size` counts two placeholder signatures.

## Regenerate

Run from the SDK root with the pinned revision available in the local PropAMM
repository. This creates only a temporary Rust build directory and the fixture
JSON; the server checkout is read-only. Cargo dependencies must be cached for
`--offline`.

```bash
fixture_sdk="$PWD"
fixture_propamm_repo="$HOME/Arch/prop-amm"
fixture_build=$(mktemp -d /tmp/aeth-usd-fixtures.XXXXXX)
fixture_source="$fixture_build/prop-amm"
mkdir -p "$fixture_build/src" "$fixture_source"
git -C "$fixture_propamm_repo" archive dfdbc9a36646066cbec067fa9e9a700232804855 | tar -x -C "$fixture_source"
cp "$fixture_sdk/tests/fixtures/aeth-usd/generate.rs" "$fixture_build/src/main.rs"
cp "$fixture_source/server/src/treasury_mint.rs" "$fixture_build/src/treasury_mint.rs"
cat > "$fixture_build/Cargo.toml" <<EOF
[package]
name = "aeth-usd-fixture-generator"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
arch_program = "=0.12.0"
arch_sdk = "=0.12.0"
apl-token = { version = "=0.12.0", features = ["no-entrypoint"] }
apl-associated-token-account = { version = "=0.12.0", features = ["no-entrypoint"] }
propammprogram = { path = "$fixture_source/program", features = ["no-entrypoint"] }
serde_json = "1"
hex = "0.4"
EOF
cargo run --offline --manifest-path "$fixture_build/Cargo.toml" -- "$fixture_sdk/tests/fixtures/aeth-usd/transactions.json"
```
