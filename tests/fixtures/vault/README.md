# Vault quote provenance

`contract.json` is an unchanged-value subset of `arch-vaults/fixtures/client-contract.json`:
its constants, `accounts.Vault` (renamed `vault`), and the 12 `shares_for_assets`,
`assets_for_shares`, and `fee_percentage` vectors. The source fixture is generated
by `crates/client/tests/client_contract.rs`; no SDK code generates expectations.

Inspected 2026-09-16 at arch-vaults revision
`84bec2abcb3f289751701f3a0afdb97fc12bb701`:

- Decoder/APL/preview starting points: `clients/ts/vault-rpc-client/src/{state,apl,preview}.ts`.
- Native behavior: `crates/core/src/{logic,state/vault}.rs` and
  `programs/vault/src/instructions/{mint,redeem,fill,report}.rs`.
- Additional hand-transcribed test cases: `crates/core/src/tests/mint_pipeline.rs`
  (pre-flow pricing, full-input cap, NAV boundaries) and `fill.rs` (TC-FEE-17).

The sibling worktree was dirty. Of these inputs, only `logic.rs` differed from
HEAD, in a performance-fee documentation comment; no relevant behavior differed.
SHA-256 of the inspected fixture:
`fca611005f3fc8f2480ac3f56adff39980d19714b5b3b6953e7fb2ba94ebb986`.
SHA-256 of the inspected `logic.rs`:
`65c278174f8f83c51eb1656c33700f2eb57fa95b68986aed0acceacba4362f7a`.

The compact port decodes only needed vault fields and APL supply/decimals/balance
and identity fields. It uses native u64/u128 bounds, virtual offsets, floor
conversions, and ceiling percentage fees. Router-specific length and identity
rules use arch-swap-router revision `40dd9c6a5fa2dbbf7dc332dcb3d0500b7a0c8958`.

Corrections to the original implementation plan and upstream TS preview:

- Management fees accrue only during `Report`. Mint/Redeem use the observed
  share supply; the SDK does not anticipate a future report.
- The native Mint cap counts the **full deposit**, including fees. The upstream
  `previewVaultMint` cap check used net assets and is not copied.
- Only Mint checks NAV freshness. Native `redeem.rs` / `fill.rs` do not.
- Router vault decoding requires exactly 616 bytes; the upstream TS decoder
  accepts longer buffers. Intermediate u128 multiplication bounds are retained.

`tests/vault.test.ts` separately builds synthetic account responses by modifying
the Rust layout fixture. These are not live snapshots. Direct quote account lists
are checked against all four existing Rust direct-vault transaction fixtures;
fee owners and queue tail 42 match that generator. New amounts/minima are checked
independently, without using the SDK encoder to calculate expected bytes.
APL tests pin the standard 82/165-byte layouts and option/initialization tags;
the upstream vault contract contains no APL account vectors.

To refresh, regenerate the upstream contract with
`UPDATE_CLIENT_CONTRACT=1 cargo test -p vault-client --test client_contract`,
copy the same subset, and review changes against the native handlers. Do not
regenerate expectations from this SDK. No live transactions are covered here.
