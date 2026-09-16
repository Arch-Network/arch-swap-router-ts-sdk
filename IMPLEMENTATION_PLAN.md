# Router SDK implementation tracker

Updated: 2026-09-16. Revised checkpoints completed: **5 / 6**.

Implement the [compact SDK plan](SIMPLIFICATION_PLAN.md): one quote call
returns one estimate and its instructions for a fixed supported pair. That plan
supersedes the older [handover](HANDOVER.md). Current Rust source and independent
fixtures remain authoritative for the ABI.

All 12 fixed directions have estimates and instructions. Direct vault Mint/Redeem
quotes use one four-account batch; CLAMM routes use two shared batches total.
The internal builder returns only the router instruction with its ATA/system
trailer, without separate ATA creation, compute-budget instructions, or sizing.

## Checkpoint overview

- [x] 1. Router codec and independent fixtures
- [x] 2. Instruction bundles
- [x] 3. Compact API and fixed-pair scaffold
- [x] 4. Request validation, account reads, and vault estimates
- [x] 5. CLAMM estimates and fixed-route composition
- [ ] 6. Frontend example and package verification

Next: checkpoint 6, the frontend example and package/browser verification.
All 12 fixed directions have fixture-backed quote coverage. A completed quote
returns instructions, not a guarantee of transaction execution.

## 1. Router codec and independent fixtures

- [x] Encode Mint, Redeem, and CLAMM steps with Rust-compatible framing, integer
  widths, little-endian fields, and millisecond deadlines.
- [x] Strictly decode the 17-byte router result; keep the decoder internal.
- [x] Match independent fixtures and reject invalid integer ranges, step counts,
  result lengths, and result versions.

**Historical evidence:** Completed 2026-09-16. The standalone Rust generator
produced 31 instruction and 12 result fixtures from router revision
`40dd9c6a5fa2dbbf7dc332dcb3d0500b7a0c8958`; see
[provenance and regeneration](tests/fixtures/router-codec/README.md).
Typechecking, build, all **89 tests** at that checkpoint, and a separate strict
TypeScript check of the new tests passed. The upstream parser/IDL suite and live
transactions were not run. Receipt status/identity handling is outside the
revised SDK scope.

## 2. Instruction bundles

- [x] Assemble ordered mint/ATA pairs, venue groups, and the ATA/system trailer
  in the router instruction. The original leading input-ATA instruction was
  subsequently removed in checkpoint 3.
- [x] Preserve duplicate account positions and correct signer/writable flags.
- [x] Keep assembly synchronous and independent of account reads.
- [x] Match independent Rust account-order, privilege, and instruction fixtures.

**Historical evidence:** Completed 2026-09-16. All 18
[Rust-generated transaction fixtures](tests/fixtures/transactions/README.md)
matched. Typechecking, build, all **146 tests** at that checkpoint, and a separate
strict TypeScript check of the new tests passed. The generator uses native
`arch_program` 0.8.7 PDA derivation and message serialization with its own lockfile.

The original checkpoint also implemented signed-size verification, accepting the
1,211-byte fixture and rejecting the 1,275-byte fixture. **Size verification and
the extra input-ATA instruction were deliberately removed in checkpoint 3.**
Preserve the original fixture data and provenance. Those historical counts are
not a test run of the revised SDK and establish no live compatibility.

## 3. Compact API and fixed-pair scaffold

- [x] Replace client configuration with `createRouterClient({ source })` and
  expose `quoteExactIn({ inputMint, outputMint, amountIn, slippageBps, user,
  deadlineMs })`, using the fixed testnet deployment/venues internally.
- [x] Define the flat `SwapQuote` from [the agreed API](SIMPLIFICATION_PLAN.md#public-api-and-fixed-routes):
  input/output mints, input amount, estimated output, minimum output,
  instructions, and deadline. Export mint constants and `SUPPORTED_PAIRS`.
- [x] Remove the old method without aliases, result arrays, candidate failures,
  public per-hop structures, `limit`, `expectedSignedSize`, and
  `quotedAtUnixSeconds`. The frontend owns quote refresh timing.
- [x] Add explicit ordered routes for all 12 directed pairs. Test continuity,
  operations, unique mints, and one-to-three-hop lengths in the registry.
- [x] Reject unsupported/identical pairs with `UNSUPPORTED_PAIR` before reads.
  Supported calls still reject with `NOT_IMPLEMENTED` during this checkpoint.
- [x] Remove graph/ranking modules, unused adapter/discovery scaffolding, the
  quote limit constant, and the PropAMM placeholder.
- [x] Remove the sizing module, dummy compilation/signatures, size-specific
  errors, and dedicated size tests. Final transaction sizing belongs to the app.
- [x] Return only the router instruction, with its ATA/system trailer for native
  ATA creation. Remove the separate input-ATA instruction and add no compute
  instruction; compute provisioning is separate router/runtime integration work.
- [x] Simplify internal builder inputs to avoid duplicated request/quote values
  and repeated runtime checks of SDK-owned route/metadata. Retain encoding
  bounds and correct instruction construction.
- [x] Preserve instruction/PDA/codec fixture coverage. Replace tests of removed
  fixed-route runtime guards with registry checks; retain original fixture data.
- [x] Update README, handover, and test documentation to describe the new API and
  actual implementation status. Keep this tracker and the separate scope plan.
- [x] Pass typecheck, build, and the remaining tests; inspect public declarations
  for obsolete exports and fields.

**Complete when:** the smaller public API and fixed lookup exist, unsupported
pairs fail explicitly, supported requests remain honest placeholders, and the
retained construction fixtures pass. No quote implementation is required here.

**Evidence / notes:** Completed 2026-09-16. The compact API, frozen fixed registry,
and named resolved-step builder inputs are implemented. Graph/ranking/adapter
scaffolding, size checks, response timestamps, and separate ATA creation are
removed. All 18 original Rust router-instruction expectations still match;
fixture JSON and generators are unchanged. Typecheck, build, all **150 tests**,
and a separate strict TypeScript check of all test files pass. Public declarations
were inspected for removed exports/fields. No live transactions, browser checks,
or runtime compute adjustments were performed.

## 4. Request validation, account reads, and vault estimates

- [x] Validate addresses, positive `u64` input, integer slippage `0..9999`, and
  nonnegative safe-integer deadlines before reads. Preserve the deadline exactly;
  leave expiry decisions to the app/chain.
- [x] Read ordered `AccountInfoResult | null` batches with request-local
  deduplication. Preserve missing values; reject transport failures and malformed
  responses. Each public call starts fresh; no persistent cache or new transport.
- [x] Capture one internal evaluation time for Mint NAV checks.
  Do not add a public quote timestamp or freshness guarantee.
- [x] Vendor the minimal vault decoder, APL readers, and preview dependencies
  with source revisions and contract fixtures. Use the SDK's fixed identities.
- [x] Fetch vault state, both mints, and the canonical reserve in one batch.
  Check the shape, ownership, and relationships of calculation inputs.
- [x] Use observed share supply: management fees accrue only during native
  `Report`, not Mint/Redeem. Preserve native fees, virtual offsets, raw units
  without decimal rescaling, rounding, and overflow behavior. Enforce pauses,
  the full-deposit cap, and Mint NAV freshness.
- [x] For immediate Redeem, require an empty observed queue, gross reserve
  coverage, and positive net output. Current native Redeem/fill has no NAV
  freshness requirement; do not introduce an additional SDK restriction.
- [x] Derive fee destinations from observed recipients and the redemption entry
  from the same observed queue tail. Do not fetch fee/escrow/entry accounts for
  execution readiness, or read wallet balances, user ATAs, or program accounts
  solely for preflight.
- [x] Return one estimate/instruction bundle for both Mint and Redeem directions.
  Apply slippage once to final output and require a positive minimum.
- [x] Test vault math/eligibility, invalid inputs/responses, missing state,
  transport errors, one-batch direct quotes, and fresh reads on subsequent calls.
  Verify construction performs no extra reads.
- [x] Pass the required checks.

**Complete when:** all four directed vault pairs return fixture-backed estimates
and instructions through `quoteExactIn` with the single-batch read budget.

**External limitation:** the native immediate-fill-or-abort guarantee is pending.
Observed redemption eligibility can change before execution. Use the current
ABI; do not add a flag or fall back to queued redemption.

**Evidence / notes:** Completed 2026-09-16. One new production module,
`src/vault.ts`, contains vault decoding, conversion, and resolution; shared
account/APL, checked arithmetic, fee, and PDA helpers stay in `src/utils.ts`.
All four direct paths return estimates and one
router instruction with exactly one batch of four accounts. The untouched Rust
vault layout, 12 native math vectors, and four existing direct instruction
fixtures cover the port. See [vault provenance](tests/fixtures/vault/README.md).
Typecheck, build, all **266 tests**, and a strict TypeScript check of the test
files pass. No live or browser verification was performed.

Native source review corrected three earlier assumptions: management fees are
Report-only, the Mint cap counts gross deposits, and Redeem/fill has no NAV
freshness guard. The implementation follows native Rust rather than those
earlier plan statements or the upstream TS cap preview.

## 5. CLAMM estimates and fixed-route composition

- [x] Vendor only required pool/tick readers, tick selection, and exact-input math
  with provenance and source vectors; replace frontend aliases/Saturn imports.
- [x] Load calculation state for the selected fixed route in one batch, then its
  required tick arrays in a second batch. Share and deduplicate across hops.
- [x] Validate pool direction and decoded calculation inputs. Use three primary
  tick positions, zero supplements, and the quote-window price limit. Preserve
  repeated boundary arrays and native handling of genuinely absent/empty ticks.
- [x] Require full input consumption, use zero per-hop slippage, and feed each
  estimated net output into the next fixed hop. Apply final slippage once.
- [x] Build from resolved state without more reads, candidate selection, ranking,
  transaction sizing, or execution-only account probes. A failure rejects the
  one quote call; there is no alternative-route fallback.
- [x] Verify both CLAMM directions, fees/rounding, negative ticks, crossings,
  boundary repetition, and insufficient windows against source vectors.
- [x] Verify all 12 fixed directions, including two-/three-hop composition and
  exact input/minimum/deadline encoding. Require at most two upstream reader
  calls for routes containing CLAMM and fresh reads on the next quote call.
- [x] Pass the required checks.

**Complete when:** all fixed pairs return fixture-backed estimates and correct
instructions. These checks do not establish live executability.

**Evidence / notes:** Completed 2026-09-16. One new production module,
`src/clamm.ts`, contains minimal pool/tick decoding, native tick-window selection,
and exact-input math. Shared PDA, binary and arithmetic helpers stay in
`src/utils.ts`. The client reads the selected route's inputs once, loads its
CLAMM arrays once, then composes synchronous vault/CLAMM estimates and builds one
router instruction. The unused `NotImplementedError` and quote placeholders are
removed; no runtime dependencies were added.

Verified reader budget per successful quote:

| Route | First batch | Second batch | Total SDK reader calls |
| --- | --- | --- | --- |
| Direct vault Mint/Redeem | 4 accounts | None | 1 |
| Direct CLAMM | Pool + 2 mints (3) | Up to 3 tick arrays | 2 |
| Vault + CLAMM, either order | 6 accounts | Up to 3 tick arrays | 2 |
| Redeem + CLAMM + Mint | 9 accounts | Up to 3 tick arrays | 2 |

Shared mints and repeated boundary arrays are deduplicated. Fee destinations,
redemption entries, the oracle and user ATAs are derived without fetches.
Physical HTTP counts depend on the application's batched reader.

An independent Rust generator calls native CLAMM math and vault plans: 21 swap
cases, 11 tick prices, native serialized layouts, and all 12 composed route
outputs. Tests cover signed liquidity, tick crossings and gaps, fee rounding,
overflow, exhausted windows, and recovery after a minimum-price crossing. All
12 public routes also match the existing Rust instruction account lists and
encode the estimate, final minimum, deadline, and native window limit. See
[CLAMM fixture provenance](tests/fixtures/clamm/README.md).

Typecheck, build, all **352 tests**, and a separate strict TypeScript check of
test files pass. The original transaction fixtures are unchanged. No live
transactions or browser verification were performed; native immediate-fill-or-abort
support and runtime compute provisioning remain external work.

### Receive-side sizing addition

Completed 2026-09-16. `quoteForOutput` accepts a desired raw output amount and
returns the existing `SwapQuote` with a calculated fixed input. The shared flow
prepares decoded state and addresses once, uses at most 64 local binary-search
probes plus final validation, and applies output slippage once after sizing.
Integer rounding can overshoot the requested estimate. The transaction remains
exact input; no router ABI, new dependency, or additional account fetch is needed.

All 12 native route outputs are reachable through the new method; tests verify
minimal input, forward-quote/instruction parity, unchanged read counts, tick
crossings, u64 precision, rounding, and capacity/state failures. Typecheck, build,
all **389 tests**, and strict test-file typechecking pass. Frontend integration
and live execution remain separate work; checkpoint 6 is still pending.

## 6. Frontend example and package verification

- [ ] Demonstrate a batched reader normalizing `owner`/`data` to `Uint8Array`, one
  quote call, and application-owned compilation, sizing, signing, and submission.
- [ ] Document refresh timing and deadline handling as frontend responsibilities.
  Resolve indexer cache misses in the app reader before returning account absence.
- [ ] Verify an installed tarball in Node and a real browser, including PDA
  derivation and a fixture-backed quote. Document the small explicit `Buffer`
  setup required by Arch SDK 0.0.28; avoid broad Node polyfills.
- [ ] Add package/typecheck/build/test CI and confirm no sibling dependencies,
  frontend aliases, or undeclared imports are packed.
- [ ] Pass the required checks.

**Complete when:** the package works independently of sibling repositories and
its example demonstrates the compact API and application transaction handoff.

Optional testnet smoke work remains separate: explicitly configure credentials,
leave funded runs disabled by default, and test direct routes before multi-hop.
Record actual source/deployment revisions, transaction references, and observed
results separately from fixture coverage. No live scenario is verified by this
documentation update.

**Evidence / notes:** Pending.

## Completion rules

Keep the package private, the existing pinned dependencies, and exact-input
testnet scope. Graph discovery, ranking, configurable venues, PropAMM, broader
tick windows, prefetch optimizations, and expanded receipt helpers are deferred.
The application owns refresh, final transaction sizing, signing, submission,
deadlines around signing, confirmation, and retries.

The SDK emits no ATA-creation or compute-budget instruction. Its router trailer
enables native ATA creation. Sufficient compute must be provisioned separately
in router/runtime integration; the SDK cleanup does not raise the runtime limit.

Mark a checkpoint complete only after its acceptance cases and required checks
pass. Record evidence and update the completed count. Preserve the distinction
between historic checks, current fixture coverage, and authorized live runs.

```sh
pnpm typecheck
pnpm build
pnpm test
```

Use `pnpm install --frozen-lockfile` when dependencies need installation.
