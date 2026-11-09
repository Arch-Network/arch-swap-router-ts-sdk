# Treasury Mint Routing Implementation Plan

Status: treasury server support is reconciled with merged CLAMM support in `~/Arch/propamm-temp/prop-amm` on `main` at `82f41a2`. All four treasury route shapes pass server validation/signing tests. The router adapter and SDK are implemented locally; cross-repository native integration, deployment and funded verification remain pending.

**Server merge hold:** the PropAMM routing changes remain unmerged until further notice from the user. SDK preparation supports the current treasury quote format using fixed input bounds when authorization metadata is absent. Do not treat preparation as evidence that the serving server can co-sign composed treasury transactions.

**Earlier patch separation (2026-11-04):** `~/Arch/prop-amm` was left on `minting` at `de11093` with treasury-only changes, accepting treasury and Redeem → treasury. That separate checkout remains unchanged by the reconciliation below.

**Reconciliation (2026-11-04):** the user supplied `~/Arch/propamm-temp/prop-amm`, a clean `main` checkout at `82f41a2e09f29486720fa003373b797140f0bdc4` with PR #115 (minting) and PR #124 (CLAMM decoding) merged. Treasury authorization/co-signing was reapplied there, reusing upstream CLAMM validation and restoring both CLAMM-prefixed treasury routes. Native/lending restrictions and version reporting are preserved. Two existing CLAMM freshness-test calls were updated for minting's explicit-signer API; production signing code is unchanged. The reconciled changes are uncommitted and undeployed. See the [current server handoff](../propamm-temp/prop-amm/docs/treasury-routing.md#reconciliation-and-remaining-rollout).

Original mint implementation reference: PropAMM `origin/minting` at `de11093e3291c4d18ec211a85038c7e7c80301b3`, refreshed and inspected on 2026-11-03. The service inspected in Step 1 reported descendant build `ced1e64a5982e8897a44e23b59481615da4f2813` (`origin/prime-markets`). Step 1's deployment matrix and evidence are linked below; the current reconciliation baseline is `82f41a2` as recorded above.

## 1. Objective and agreed behavior

Make treasury minting an executable route step, initially supporting these exact-input buys:

| Input | Route to aETH |
|---|---|
| aUSD | Treasury mint |
| primeUSD | Redeem → treasury mint |
| aBTC | CLAMM → treasury mint |
| primeBTC | Redeem → CLAMM → treasury mint |

The implementation will follow these agreed decisions:

- Register aETH first, while keeping the treasury step reusable for future assets.
- Follow the server’s market mode: a buy quote resolves into either a regular swap or treasury mint.
- Consume the preceding hop’s measured aUSD output and scale the mint at the quoted rate.
- Use the existing `max_input_shortfall_bps` symmetrically to authorize input above and below the nominal amount.
- Enforce both the issued bounds and the current on-chain allowance. Tightening the allowance can invalidate an outstanding quote.
- Allow treasury minting only as the final hop, with at most three total hops and exactly one server-authorized step.
- Keep composable buys and sells automatically available through the configured provider, without feature flags.

Parallel competition between minting and regular swaps, multiple RFQ hops, treasury redemption, and exact-output RFQ routing are deferred.

## 2. Shared execution contract

### Existing implementation on `minting`

The branch already implements direct treasury buys. Reuse that implementation when adding routed execution; the bounds metadata and router step specified below are additions, not fields or instructions already served by this branch.

This section describes the pinned source baseline before the local routing patch. The Step 2 and Step 4 checklists record the implemented additions. The reduced scope agreed after Step 1 keeps the treasury builder, quote preparation, pricing and key loading with their existing owner; bounded routing uses a separate authorization helper and narrow quote/submission hooks.

Source references in this section are relative to `~/Arch/prop-amm` at the pinned revision. Read them with `git show <revision>:<path>` without changing the working checkout.

| Source | Existing responsibility |
|---|---|
| `config/src/lib.rs`, `server/src/market.rs`, `server/src/state.rs` | Market mode, bridge program binding and treasury signer loading |
| `server/src/chain.rs` | Nominal amounts, expiry, fresh issuance ID and treasury quote preparation |
| `server/src/treasury_mint.rs` | Quote-token payment and bridge mint instruction builders; bridge-client ABI golden vector |
| `server/src/routes/quote.rs`, `server/src/pricing_engine.rs` | Request/response types, engine pricing and payout-limit parsing |
| `server/src/routes/rfq.rs`, `server/src/rfq.rs` | Issued quote storage, direct-message validation, signing, claiming and submission |

**Configuration and mode selection:**

- A market's `treasury_mint_program_id` selects the bridge program. `chain::treasury_mint_bridge` activates it only for `Buy`; sells remain native PropAMM swaps.
- `server.treasury_mint_key_file` names a key file beneath `key_dir`. Config validation requires it when a treasury market is configured. `AppState::treasury_minter` exposes the loaded signer. Reuse this signer; do not introduce a second treasury key setting.
- There is no per-request buy-mode selector. `QuoteRequestJson` contains `base_mint`, `quote_mint`, `side`, `amount`, `user_pubkey` and optional `slippage_bps`. Mint and user identities are hex strings; `amount` is a u64 in input-token base units.
- The inspected SDK/server baseline uses Arch 0.13. CLAMM validation originally absent from the pinned `minting` tip is now merged in the `82f41a2` reconciliation baseline. Its decoder/account validation and `server.router.clamm_program_id` binding are reused by the treasury patch.

**Quote construction:**

`chain::prepare_quote_transaction` computes nominal base/quote amounts, assigns the usual quote expiry, generates a fresh random 32-byte issuance ID and calls `treasury_mint::buy_instructions`. That builder produces exactly two instructions:

1. APL Token `Transfer`, tag `3`: move nominal quote amount `A` from the user's canonical quote-token ATA to the canonical PropAMM quote vault. Account order is source ATA (w), payment vault (w), user (signer). Data is the tag followed by `A` as a little-endian u64, totaling 9 bytes.
2. Bridge `MintFromTreasury`, tag `21`: mint nominal base amount `B` directly to the user. Data layout is defined below.

The unsigned response is a flattened version-0 `RuntimeTransaction` with `quote_id`, `expires_at_ms` and `estimated_quote`. Its two signers are the writable user fee payer and writable treasury authority. The quote estimate contains the exact nominal amounts, neutral `adjustment_fp = 1_000_000`, and the quote-vault observation timestamp. No native aETH inventory skew applies.

The direct mint instruction is exactly 73 bytes:

| Byte range | Value |
|---|---|
| `0` | Bridge instruction tag `21` |
| `1..33` | Issuance ID, 32 bytes |
| `33..41` | Mint amount `B`, u64 little-endian |
| `41..73` | Recipient public key, 32 bytes |

Its 11 accounts, in order, are:

| Position | Account or derivation under the bridge program | Privileges |
|---:|---|---|
| 0 | Treasury authority | Writable signer; bridge rent payer |
| 1 | Config PDA: `["config"]` | Read-only |
| 2 | Asset config PDA: `["asset", outputMint]` | Read-only |
| 3 | Issuance receipt PDA: `["treasury_mint", issuanceId]` | Writable |
| 4 | Output mint | Writable |
| 5 | Mint-authority PDA: `["mint-authority", outputMint]` | Read-only |
| 6 | Recipient user | Read-only |
| 7 | Recipient's canonical output ATA | Writable |
| 8 | APL Token program | Read-only |
| 9 | Associated token program | Read-only |
| 10 | System program | Read-only |

The payment vault derives from `["vault", propammConfig, inputMint]` under the PropAMM program. It is not a bridge custody account. The bridge's permanent issuance receipt provides mint replay protection; this path does not invoke native `ExecuteTrade` or consume its user nonce. The bridge mint data contains neither a price nor an expiry, so the new router step must enforce those terms itself.

The builder's existing independent golden vector cites bridge PR #65, revision `79ea89e`. Preserve it as historical ABI evidence and verify it against the deployed bridge during Step 1.

**Pricing, submission and remaining gaps:**

- The configured pricing engine supplies the quote price. Engine failure does not fall back to a feed-priced quote. Submission still performs the existing fresh-feed adverse-price check.
- `max_amount` caps buy payout in base-token base units; `max_amount_usd` caps sell payout in quote-token base units. Explicit JSON `null` means no cap; a missing engine response field defaults to `"0"`, not unlimited. Preserve this distinction when deriving `L` below.
- `IssuedRfqQuote` already stores the prepared packet, a cloned market, reference price and payout limit. Extend this snapshot with typed treasury authorization while preserving its existing issuance-time bindings.
- The current `validate_submission` takes the exact-message branch for every treasury quote (`minted || is_direct(...)`). A rebuilt router message is therefore rejected before routed validation. Step 4 must distinguish unchanged direct treasury messages from canonical routed treasury messages.
- The current treasury branch of `finalize_and_submit` bypasses native estimation, but also bypasses `validate_payout_limit`, which is called only in the native branch. Add explicit cap enforcement at treasury issuance and finalization, including legacy direct mints. Do not assume the README's stated cap is already enforced on this path.
- Treasury quote preparation currently requests a cached base/quote vault pair before selecting the mint branch. Move treasury dispatch before that native-pair dependency; retain the payment-vault observation needed by the existing estimate metadata. Keep normal cache checks and vault tracking for native swaps and sells.
- The branch has no composable treasury bounds metadata or router treasury step. Preserve its exact-message direct compatibility, authenticated quote claiming and message-bound retry behavior while adding them.

### Quote response and SDK interfaces

Keep the existing quote request and response transaction format. A treasury quote continues to contain its nominal aUSD transfer followed by the bridge’s `MintFromTreasury` instruction.

Add this optional response field for treasury quotes that authorize variable input:

```ts
treasury_authorization: {
  version: 1;
  min_amount_in: string; // unsigned decimal integer, aUSD base units
  max_amount_in: string; // unsigned decimal integer, aUSD base units
}
```

Continue using the existing `quote_id`, `expires_at_ms`, and `estimated_quote` fields. Decode nominal payment, nominal mint amount, issuance ID, recipient and accounts from the original transaction.

Extend `DirectRfqQuote` with:

```ts
treasuryAuthorization?: {
  readonly version: 1;
  readonly minAmountIn: bigint;
  readonly maxAmountIn: bigint;
}
```

Existing native providers remain compatible. As agreed during Step 5, treasury responses without this field remain usable for SDK preparation with fixed bounds: `minInput = maxInput = quotedInput`. They authorize no input variation; a prefix whose measured output differs from nominal input fails on-chain. The SDK must never synthesize a tolerance from slippage or default policy. Malformed or explicit-null metadata is rejected rather than treated as absent. Composed treasury submission still requires the pending server validator changes, which remain unmerged until further notice.

The client continues returning `RouterSwapQuote`, including `rfq.quoteId`, executable router instructions and a `treasuryMint` hop.

### Pricing and authorization bounds

All calculations use checked integer arithmetic in token base units.

Let:

- `A` be nominal quoted aUSD input.
- `B` be nominal quoted aETH output.
- `b` be the input allowance in basis points at issuance.
- `L` be the pricing engine’s payout limit, or `u64::MAX` for an explicitly unlimited limit (or an existing deployment without a pricing engine). A missing limit field in an engine response is zero, as described above.

Calculate:

```text
policyMin = max(1, ceil(A × (10_000 − b) / 10_000))
policyMax = min(u64::MAX, floor(A × (10_000 + b) / 10_000))

minimumProducingOutput = ceil(A / B)
maximumWithinPayoutLimit = floor(((L + 1) × A − 1) / B)

minInput = max(policyMin, minimumProducingOutput)
maxInput = min(policyMax, maximumWithinPayoutLimit)
```

Reject issuance unless `A` and `B` are positive and the resulting interval contains `A`. This also rejects a nominal payout above the engine limit.

At execution, for measured input `X`:

```text
require minInput ≤ X ≤ maxInput
require X also satisfies the current on-chain symmetric allowance
Y = floor(X × B / A)
require Y > 0 and Y fits u64
```

Transfer exactly `X` aUSD to the canonical PropAMM quote vault and mint exactly `Y` aETH to the user. Do not apply native inventory skew. Apply the user’s slippage minimum once, to the route’s final measured output.

### Router wire format

Append treasury mint as step tag `4`, preserving existing tags and the V1 route header:

```text
[4]
[issuance_id: 32 bytes]
[quoted_input: u64]
[quoted_output: u64]
[min_input: u64]
[max_input: u64]
[expiry_ms: u64]
```

The step occupies 73 bytes. All integers are little-endian.

Use this ordered venue account group:

| Position | Account | Privileges |
|---:|---|---|
| 0 | Bridge program | Read-only, executable |
| 1 | Treasury authority | Writable signer |
| 2 | Bridge config PDA | Read-only |
| 3 | Bridge asset config PDA | Read-only |
| 4 | Issuance receipt PDA | Writable |
| 5 | Bridge mint-authority PDA | Read-only |
| 6 | PropAMM config PDA | Read-only |
| 7 | PropAMM payment vault | Writable |
| 8 | Associated token program | Read-only, executable |
| 9 | System program | Read-only, executable |

Reuse the route’s user, token program, node mints and user ATAs. Mark the treasury output mint writable.

The adapter invokes the existing 11-account bridge instruction, tag `21`, with the issuance ID, scaled amount `Y` and route user as recipient. Its 73-byte bridge payload is separate from the new 73-byte router step, tag `4`; do not pass the router payload directly to the bridge.

Treasury transactions require two writable signers: user and treasury authority. Native RFQ transactions retain their existing signer privileges.

## 3. Implementation checklist

### Step 1 — Verify deployment identities and compatibility

- [x] Record the actual service's effective public configuration behind `https://vaults.veloxapi.net/propamm`; do not infer it from `mainnet-v2.toml`.
- [x] Verify deployed bridge program/IDL, asset configuration, treasury authority, output mint authority, PropAMM config and payment vault.
- [x] Resolve the differences between the captured treasury response and the SDK’s historical bridge/authority pins.
- [x] Record source revisions and the deployment identities used by router builds, server validation and SDK fixtures.
- [x] Confirm the deployed bridge's published `MintFromTreasury` ABI, existing permanent-receipt layout and replay namespace; fresh replay execution remains in Step 6.
- [x] Confirm the Arch 0.13 runtime profile and its 4,096-byte / 50-key packet limits from matching SDK/source constants.

**Done when:** a public deployment matrix establishes one consistent set of verified identities and ABI fixtures. A captured quote alone does not establish execution compatibility.

**Completed evidence:** [deployment matrix and verification report](tests/fixtures/treasury-mainnet-v2/README.md), [public account/IDL/quote snapshot](tests/fixtures/treasury-mainnet-v2/deployment.json) and [independent Rust ABI fixtures](tests/fixtures/aeth-usd/README.md).

The deployed bridge is `F5uRFVRuupfFgw1L5x7uWt41ug7MTZr2BfnfZiFj12fk`; its aETH treasury authority is `GPoZuMS41Ct92nUUqWyu8dqCY74QkfHRX8N3RsYiTCAT`. SDK pins and native fixtures now match these verified identities. The full published bridge IDL equals the normalized local v0.4.3 template, and two existing aETH receipts match the expected authority and issuance PDAs. Both unsigned buy and sell quotes returned HTTP 200. After the refresh, 940 offline SDK tests, typecheck and build passed.

**Limits and rollout findings:** the service reports build `ced1e64` and degraded health (`price_feed_active = false`), despite successful aETH quotes. That source revision includes minting and the `engine_asset` override but lacks the newer CLAMM validator. Raw server TOML and enabled router bindings are not exposed publicly and must be checked during Step 7's rollout. IDL/state checks and recorded ELF fingerprints are not a reproducible-build attestation or fresh mint/replay execution proof.

### Step 2 — Issue bounded treasury authorizations in PropAMM

**Depends on Step 1.**

- [x] Reuse CLAMM configuration, decoding and account validation already merged in `main`, without carrying a separate CLAMM implementation.
- [x] Reconcile treasury mode with the merged shared decoder/accounts and restore the two CLAMM-prefixed treasury acceptance scenarios.
- [x] Reuse `treasury_mint_program_id`, `server.treasury_mint_key_file`, `AppState::treasury_minter` and the existing payment/mint builders rather than adding parallel configuration or signing paths.
- [x] Freeze treasury authorization on `IssuedRfqQuote`, alongside its existing immutable market and quote terms.
- [x] Bind issuance ID, nominal amounts, expiry, authorized bounds, payout limit and account identities through the stored original packet and authorization.
- [x] Implement the range calculation above and enforce the engine payout cap across the full authorized range; retain missing-field-as-zero and explicit-null-as-unlimited engine semantics.
- [x] Return `treasury_authorization` using decimal strings for its amounts; omit it for native quotes.
- [x] Retain the existing nominal two-instruction transaction response for compatibility.

**Done when:** quote generation produces complete bounded authorizations, rejects invalid ranges and excessive payouts, and leaves native response behavior compatible.

**Implementation:** PropAMM `server/src/treasury_routing.rs` owns the range math and stored authorization. Existing quote/submission handlers call it without changing `treasury_mint.rs`, `chain.rs`, pricing, key loading or deployment TOMLs. See [the server handoff](../propamm-temp/prop-amm/docs/treasury-routing.md) for the wire/account contract and activation requirements.

**Owner coordination outside this reduced patch:** preserve the serving branch's `engine_asset` and `quote_is_reference_asset` market behavior when merging with `prime-markets`. Moving treasury preparation ahead of the native cache-pair lookup remains with the mint implementation owner; the routing patch leaves that existing availability dependency intact.

### Step 3 — Add the router treasury step

**Depends on Steps 1–2.**

- [x] Extend decoding, account grouping, execution dispatch and IDL with step tag `4`.
- [x] Count native RFQ and treasury steps toward the same one-authorized-step limit.
- [x] Reject nonterminal treasury steps and native RFQ prefixes followed by treasury minting.
- [x] Add the bridge program identity to the existing deployment-stage binding mechanism.
- [x] Validate canonical bridge PDAs, PropAMM config, payment-vault derivation, token identities, programs and required privileges.
- [x] Read the current input allowance from the existing PropAMM config reader.
- [x] Enforce quoted bounds, current policy and positive checked output before payment.
- [x] Require the route deadline not to exceed the treasury expiry, and enforce quote expiry using the native RFQ’s conservative whole-second boundary.
- [x] Transfer measured input and invoke the existing bridge instruction.
- [x] Verify the exact input debit and scaled output credit using balance deltas.
- [x] Preserve final-output minimum checks and router return data.
- [x] Release account-data borrows before CPIs.

The bridge continues to own treasury authority validation, pause controls, supply limits, receipt creation and replay prevention. No bridge program change is planned.

**Done when:** host tests establish the new wire contract, account validation, arithmetic and CPI behavior while all existing route tests remain green.

**Implementation:** [the router adapter design](../arch-swap-router/arch-swap-router-treasury-mint-design.md) records the appended ABI, ten-account venue group, deployment bindings and native CPI contract. The adapter consumes measured input in full, intersects issued bounds with current policy and mints `floor(actual_input * quoted_output / quoted_input)`. Native payment/mint fixtures come from the unchanged PropAMM treasury builder; no bridge, treasury-builder or dependency-version changes are required.

**Validation:** host suites pass for both profiles: default/testnet has 140 passing tests and 5 ignored; mainnet has 136 passing tests and 1 ignored. Formatting and Clippy with warnings denied pass for both profiles. Both SBF builds complete, with the same pre-existing `bitcode::histogram` stack diagnostic reproduced from an untouched router baseline at `ef7920a`; that dependency issue remains unresolved. Host coverage includes account substitution/alias rejection, live-policy tightening, signed bounds, exact CPI bytes/privileges, postconditions, measured prefix credit and final minimums. Native execution, transaction rollback, compute/packet budgets and SDK-generated/server-signed interoperability remain in Step 6.

### Step 4 — Validate and co-sign routed treasury transactions

**All four treasury shapes are reconciled and tested against merged `main`. SDK support is implemented in Step 5; cross-repository execution evidence remains in Step 6. The treasury additions remain uncommitted and undeployed.**

- [x] Add a distinct routed-treasury submission kind instead of routing it through native swap estimation.
- [x] Preserve exact-message validation for legacy direct treasury submissions.
- [x] Replace the treasury-wide exact-message rejection in `validate_submission` with explicit direct and routed validation branches; never accept an arbitrary modified direct message as a route.
- [x] Require an explicit `quote_id` for routed submissions.
- [x] Validate the complete canonical instruction bundle and compiled message, including account order, privileges and signer layout.
- [x] Match every treasury term against the immutable issued authorization.
- [x] Bind the prefix, payment vault, recipient and final mint to the issued market and user.
- [x] Permit treasury and Redeem → treasury, preserving the single-quoted-step limit and rejecting suffixes after treasury.
- [x] Permit CLAMM → treasury and Redeem → CLAMM → treasury through the merged shared validator, with their fixtures and real-signature tests restored.
- [x] Select the treasury signer from the issued mode, without reinterpreting the quote using later market configuration.
- [x] Retain existing fresh-price checks and enforce the authorized maximum payout without native inventory skew. Close the existing treasury finalization bypass of `validate_payout_limit`, including for legacy direct mints.
- [x] Authenticate the user and validate the full transaction before claiming the quote.
- [x] Preserve quote-store message binding, concurrent claim protection and existing identical-submission retry behavior.

For a CLAMM or redemption prefix, the exact runtime aUSD amount is unknown during signing. The server authorizes the bounded range; the router checks the measured amount during execution.

**Done when:** canonical routed treasury packets are accepted, altered packets are rejected before quote claiming, and native and legacy direct submissions retain their intended behavior.

**Validation after reconciliation:** 330 workspace tests pass, with 1 ignored, including 207 server tests. Formatting and server/config Clippy across all targets with warnings denied pass. Treasury tests cover all four shapes, 0–3 supplemental arrays, creation layouts, input tolerance boundaries, payout clipping, integer limits, canonical accounts/privileges, real user/treasury signatures and failed submissions leaving quotes unclaimed. Exhaustive grammar coverage distinguishes native and treasury modes for all step-tag sequences up to three hops. Merged native CLAMM, lending and version-reporting behavior is retained. Step 3 adds host coverage of live-policy tightening and measured prefix credit. Native execution, rollback and funded verification remain in Steps 6–8; the server alone cannot measure prefix output.

### Step 5 — Resolve treasury quotes in the SDK

**Depends on Steps 2–4.**

- [x] Keep one server-quoted aETH buy edge in graph discovery.
- [x] Resolve that edge into native swap or treasury mint according to the canonical response format.
- [x] Extract strict treasury-template validation into a decoder that produces a resolved treasury step.
- [x] Validate authorization metadata, nominal amounts, recipient, expiry, program identities, PDAs and original message privileges.
- [x] Accept legacy treasury responses with fixed nominal input bounds; reject malformed metadata and never infer a tolerance.
- [x] Add treasury encoding, account construction and output-mint writability.
- [x] Generalize RFQ bundle construction to support the treasury signer layout.
- [x] Reserve both signatures when checking transaction size.
- [x] Update the aETH HTTP provider and signing example to transport the new authorization.
- [x] Preserve wallet-message integrity checks, expiry handling and submission/confirmation behavior.
- [x] Keep receive sizing from selecting server-quoted routes.
- [x] Document the optional bounds metadata, fixed-input compatibility behavior and automatic mode resolution.

**Done when:** all four treasury buys return composable router quotes, native buys and sells still work, and no mode flag or additional quote request is introduced.

**Implementation:** the SDK's existing aETH graph edge resolves from the validated original packet into a native `propamm` or terminal `treasuryMint` step. Shared treasury-template validation preserves the original response. `src/treasury-mint.ts` derives venue PDAs locally, the codec appends tag 4, and the RFQ bundle builder supports the writable treasury signer. The HTTP/signing example preserves optional decimal-string authorization metadata. Legacy packets omit it and encode equal input bounds. Routing makes one quote request and keeps the 0 / 1 / 2 / 2 account-reader budget without fetching bridge state.

**Validation:** typecheck, package build and 1,019 offline tests pass; 20 live tests and the optional external-validator test are skipped. Coverage includes all four routes with legacy and bounded quotes, canonical payment/mint validation, input-range and integer limits, whole-second expiry, exact account order/privileges, full-u64 encoding, both signatures in size checks, wallet mutation/expiry guards and native/core regressions. No PropAMM server changes were made or merged during this SDK step. Cross-repository treasury validation, native execution and funded checks remain in Steps 6–8.

### Step 6 — Prove interoperability and execution

**Depends on Steps 3–5.**

Four-route server validation/signing coverage is complete against the reconciled `82f41a2` checkout. The remaining work is SDK-generated packet interoperability and native execution evidence.

- [ ] Generate independent ABI fixtures from the actual bridge/server builders; retain the existing bridge-client golden vector, payment-before-mint test and direct treasury signer/message-validation tests.
- [ ] Extend the existing SDK-to-PropAMM validator test to cover the four treasury routes and retain the eight native aETH routes.
- [ ] Add real user/treasury signature verification for compiled packets.
- [ ] Extend the isolated native runtime harness with the bridge and CLAMM programs needed for these routes.
- [ ] Run against the Arch 0.13 runtime profile while retaining compatible on-chain dependency versions.
- [ ] Execute all four routes with missing and existing user ATAs and nonzero pre-existing intermediate balances.
- [ ] Measure fully signed bytes, unique account keys, compute usage and CPI depth.
- [ ] Verify rollback through a transaction/bank layer when payment is followed by mint failure or a final-minimum failure. A `MessageProcessor`-only test is insufficient evidence of rollback.

**Done when:** shared packets pass SDK compilation, actual server validation, signature verification and native execution, with recorded resource measurements and rollback evidence.

### Step 7 — Run live quote smoke tests

**Depends on Steps 1–6.** This step deploys the prerequisites for live smoke tests; SDK release and funded verification follow in Step 8.

- [ ] Deploy the backward-compatible router upgrade first.
- [ ] Deploy the server with treasury authorization and routed validation.
- [ ] Verify the actual serving configuration binds the verified bridge/treasury identities and the intended `server.router` program, vault and CLAMM IDs; confirm the serving build SHA and recheck price-feed readiness.
- [ ] Refresh verified deployment fixtures and SDK pins.
- [ ] Use the release-candidate SDK/provider for quote preparation before publishing it to consumers.
- [ ] Request quotes for aUSD, primeUSD, aBTC and primeBTC buys.
- [ ] Confirm each resolves into a terminal treasury step with one quote ID.
- [ ] Check expiry, signer privileges, packet limits and authorized bounds.
- [ ] Confirm sell quotes continue resolving into native swaps.
- [ ] Report quote-only evidence separately from co-signing and execution evidence.

**Done when:** the production quote format works through the complete SDK preparation path for all four buys.

### Step 8 — Release and verify funded execution

**Depends on Steps 1–7.**

- [ ] Confirm the deployed router/server revisions match the successful Step 7 smoke evidence.
- [ ] Release the SDK/provider changes after server compatibility is confirmed.
- [ ] Verify treasury-authority rent funding and bridge mint availability before funded checks.
- [ ] Execute a small buy for each supported input asset.
- [ ] Confirm payment, mint supply increase, user credit, issuance receipt and router result.
- [ ] Observe existing logs/metrics for quote mode, bound failures, bridge failures and submission status.
- [ ] Record deployed revisions and verification evidence in the implementation document.

**Done when:** all four routes have confirmed execution evidence and existing native routes remain operational.

## 4. Required acceptance scenarios

Tests should cover the financial and authorization boundaries:

- **Scaling:** nominal input, both permitted endpoints, below/above bounds, rounding, zero output and full-u64 arithmetic.
- **Policy:** zero allowance, maximum allowance, tightening after issuance, and widening that cannot expand issued bounds.
- **Payout limits:** explicitly unlimited limit, missing engine fields treated as zero, exact limit, clipped upper bound and nominal payout exceeding the limit. Cover both direct and routed treasury finalization.
- **Authorization:** altered amounts, bounds, expiry, issuance ID, user, recipient, signer, bridge, vault or mint; extra instructions/accounts/signers; changed execution mode.
- **Replay and submission:** reused issuance receipt, concurrent quote claims, invalid submissions leaving quotes unclaimed, and identical-message retries.
- **Execution:** missing ATAs, insufficient treasury rent, paused bridge, supply cap, CPI failure, final-minimum failure and preservation of pre-existing intermediate balances.
- **Regression:** native aETH buys/sells, legacy direct treasury mints, BTC RFQ routes, core vault/CLAMM routes and the existing single-quote submission contract. Native/sell cache checks must remain effective. Removing treasury quote preparation's existing native base-vault cache-pair dependency is deferred to the mint owner.

Resource acceptance:

- Fully signed transactions fit the verified runtime limits; the current Arch 0.13 budget is 4,096 bytes and 50 account keys.
- SDK quote account reads remain **0 / 1 / 2 / 2** for aUSD / primeUSD / aBTC / primeBTC inputs.
- No additional SDK bridge-account read is introduced.
- Each selected route makes one quote request.
- Runtime compute and CPI depth are measured against the deployed execution budget.

## 5. Assumptions and future extension

- The deployed bridge supports the existing treasury mint ABI; Step 1 must establish this before implementation proceeds.
- Treasury issuance IDs remain globally unique and permanently protected by bridge receipts.
- Existing server market configuration chooses buy execution mode.
- Future treasury-backed assets reuse this step by adding verified market and deployment configuration.
- Multiple quoted steps and competitive selection between treasury minting and inventory swaps require a separate authorization and submission design.
