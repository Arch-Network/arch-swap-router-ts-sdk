# PropAMM limit-order fixtures

Both files come from PropAMM `limit-orders` revision
`2d7fa57e25f5f4583ba065878c0a38d1f290f450` (PropAMM PR #127), using Arch
program `0.13.0`.

- `native.json` is written by `generate.rs`, which calls the native
  `create_limit_order_instruction` and `cancel_limit_order_instruction`
  builders, the order/escrow/ATA PDA helpers, Borsh `LimitOrder`
  serialization, `mark_filled`/`mark_cancelled` and `ArchMessage::new`. It does
  not import SDK TypeScript. Each network × side case has the create and cancel
  instructions with owner as payer, their compiled owner-paid messages, and
  open, filled and cancelled 251-byte accounts. `minimum_output_at_limit` holds
  every explicit case from `program/src/limit_math.rs` tests, with the native
  result or error label.
- `idl.json` is the limit-order subset of `idl/prop_amm.idl.json` (SHA-256
  `b55497a2f433b402ee93cfdd226d404389e8ee4cfa62dff3194975ca3df6d6ab`):
  the three order instructions, `CreateLimitOrderParams`, `LimitOrder`,
  `LimitOrderStatus`, `Side` and the `LimitOrder` account discriminator, copied
  unchanged.

Program and config IDs are the SDK's testnet and mainnet PropAMM deployments.
Mints are each network's aBTC/aUSD (8/6 decimals). The owner, order ID, amounts
and clock values are synthetic test values. The limit is 100,000 aUSD per aBTC:
the buy spends 100 aUSD for at least 100,000 sats, and the sell spends
100,000 sats for at least 100 aUSD.

## Regenerate

Run from the SDK root. Cargo dependencies must be cached for `--offline`. The
PropAMM checkout is only read.

```bash
fixture_sdk="$PWD"
fixture_propamm_repo="$HOME/Work/prop-amm"
fixture_root=$(mktemp -d /tmp/limit-order-fixtures.XXXXXX)
mkdir -p "$fixture_root/prop-amm" "$fixture_root/gen/src"
git -C "$fixture_propamm_repo" archive 2d7fa57e25f5f4583ba065878c0a38d1f290f450 | tar -x -C "$fixture_root/prop-amm"
cp "$fixture_sdk/tests/fixtures/limit-orders/generate.rs" "$fixture_root/gen/src/main.rs"
cp "$fixture_root/prop-amm/Cargo.lock" "$fixture_root/gen/Cargo.lock"
cat > "$fixture_root/gen/Cargo.toml" <<EOF
[package]
name = "limit-order-fixture-generator"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
arch_program = "=0.13.0"
borsh = "1"
propammprogram = { path = "$fixture_root/prop-amm/program", features = ["no-entrypoint"] }
serde_json = "1"
hex = "0.4"
EOF
CARGO_TARGET_DIR="$fixture_root/target" cargo run --offline \
  --manifest-path "$fixture_root/gen/Cargo.toml" -- "$fixture_sdk/tests/fixtures/limit-orders/native.json"
```

Keep the generator crate outside the extracted PropAMM tree; nesting it there
breaks the workspace-dependency inheritance. SHA-256 of `native.json`:
`f861d8c46cc5f7c5d185320b70299bfe2da44deff387dfb1ab72752295f00218`.

These fixtures pin ABI, layout, PDA and math compatibility. They do not show
that the program or order server is deployed on either network.
