# Router SDK implementation tracker

Created: 2026-09-16. Implementation checkpoints completed: **2 / 10**.

Implement one `quoteRoutesExactIn` call that discovers routes, quotes them, and
returns ranked, executable instruction bundles. The contract in
[HANDOVER.md](HANDOVER.md) and [src/types.ts](src/types.ts) remains the baseline.
Current Rust source and independent fixtures are authoritative for the ABI.

Each numbered checkpoint is a separate implementation item. Check off its tasks
as they finish; mark the checkpoint complete only when its acceptance criteria
and required checks pass. Record the evidence under that checkpoint and update
the completed count above.

## Verified starting point

- [x] Typechecking passes.
- [x] Build passes.
- [x] All 13 existing address/PDA/ATA tests pass.
- [x] Git history exists; the handover's no-Git note is outdated.

Quote behavior remains unimplemented. These checks do not establish live route
compatibility.

## Checkpoint overview

- [x] 1. Router codec and independent fixtures
- [x] 2. Instruction bundles and signed size
- [ ] 3. Request validation and request-local account reads
- [ ] 4. First working flow: direct Mint
- [ ] 5. Immediate Redeem quotes
- [ ] 6. Direct CLAMM quotes
- [ ] 7. Graph discovery, multi-hop composition, and ranking
- [ ] 8. Trustworthy receipt decoding
- [ ] 9. Package verification and frontend example
- [ ] 10. Opt-in testnet smoke coverage

Next: checkpoint 3. The first usable quote-to-instructions milestone is
checkpoint 4; complete fixture-backed routing arrives at checkpoint 7.

## 1. Router codec and independent fixtures

- [x] Implement instruction encoding for Mint, Redeem, and CLAMM.
- [x] Implement strict decoding of the 17-byte router result.
- [x] Preserve the one-byte step count, integer widths, little-endian encoding,
  and millisecond deadline.
- [x] Copy independent expectations from the Rust instruction/IDL tests and
  record their source revision. Do not generate expected bytes using the
  TypeScript encoder being tested.
- [x] Verify one-, two-, and three-hop fixtures byte for byte, both CLAMM
  directions, and full-width integers.
- [x] Verify explicit failures for invalid ranges, step counts, result lengths,
  and result versions.
- [x] Pass the checkpoint's required checks.

**Complete when:** the encoder and result decoder match the independent Rust
fixtures and reject the invalid cases above.

**Evidence / notes:** Completed 2026-09-16. Implemented
[instruction encoding](src/codecs/instruction.ts) and
[result decoding](src/codecs/result.ts). All tests remain under `tests/`:
[instruction tests](tests/codecs/instruction.test.ts) and
[result tests](tests/codecs/result.test.ts). The standalone Rust generator
produced 31 instruction and 12 result fixtures; see
[provenance and regeneration](tests/fixtures/router-codec/README.md).
Source revision: `40dd9c6a5fa2dbbf7dc332dcb3d0500b7a0c8958`.
Typechecking, build, and all **89 tests** pass (76 codec tests plus 13 existing
account tests). The new test files also pass a separate strict TypeScript check
with JSON module resolution. The source parser/IDL suite and live transactions
were not run. Codecs remain internal; receipt status/identity checks are still
checkpoint 8 work.

## 2. Instruction bundles and signed size

- [x] Implement the input-ATA instruction followed by the router instruction.
- [x] Assemble node pairs, ordered venue groups, and the ATA/system trailer.
- [x] Preserve duplicate account positions and apply the correct writable and
  signer privileges.
- [x] Use Arch SDK message compilation and transaction sizing with a dummy
  blockhash and correctly sized placeholder signatures.
- [x] Keep assembly synchronous and independent of account reads.
- [x] Match Rust account-order and privilege fixtures.
- [x] Reproduce the 1,211-byte shared-fee three-hop bundle.
- [x] Reproduce the 1,275-byte distinct-fee bundle and reject it against the SDK
  size limit.
- [x] Pass the checkpoint's required checks.

**Complete when:** account construction matches Rust and both signed-size
fixtures produce the expected acceptance/rejection.

**Evidence / notes:** Completed 2026-09-16. Implemented
[bundle construction](src/transactions/instructions.ts) and
[signed-size measurement](src/transactions/size.ts), using the existing resolved
hop account groups and Arch SDK utilities. Assembly preserves duplicate positions,
validates structural group/route consistency, and performs no reads. Tests remain
under [tests/transactions](tests/transactions). All 18
[Rust-generated fixtures](tests/fixtures/transactions/README.md) match, including
both three-hop directions at 1,211 bytes (accepted) and 1,275 bytes (rejected).
Typechecking, build, all **146 tests**, and a separate strict TypeScript check of
the new test files pass. The fixture generator uses native `arch_program` 0.8.7
PDA derivation and message serialization; it runs offline with its own lockfile.
No runtime dependencies or public methods were added. Venue-state validation,
quoting, missing-ATA compute, and live execution remain later work.

## 3. Request validation and request-local account reads

- [ ] Validate client configuration, unique venue IDs, and addresses.
- [ ] Validate positive `u64` input, distinct input/output mints, slippage
  `0..9999`, safe nonnegative integer deadlines, and positive integer limits.
- [ ] Default the limit to three and preserve the caller's deadline without
  extending it.
- [ ] Implement ordered account reads with a per-request map that avoids
  repeated fetches.
- [ ] Keep `AccountInfoResult` directly. Missing accounts remain `null`; reader
  failures and malformed reader responses reject the request.
- [ ] Extend only the internal quote context with the wallet identity and one
  captured quote-evaluation time for venue checks.
- [ ] Verify invalid requests fail before reads, repeated reads reuse
  request-local data, and separate calls read fresh state.
- [ ] Verify transport failures cannot become liquidity failures.
- [ ] Pass the checkpoint's required checks.

**Complete when:** validation and ordered account access obey the contract,
without persistent caching or another account model.

**Evidence / notes:** Pending.

## 4. First working flow: direct Mint

- [ ] Vendor the necessary vault decoder, APL readers, and pure preview
  dependencies, with provenance and contract fixtures.
- [ ] Use explicit deployment identities instead of the vault package's
  deployment wrappers.
- [ ] Validate vault, mint, reserve, and fee-account relationships, pause state,
  NAV freshness, and deposit caps.
- [ ] Apply management-fee share accrual before calculating Mint output.
- [ ] Preserve native fees, virtual offsets, decimals, rounding, and overflow
  behavior.
- [ ] Wire direct connections derived from configured venues into the public
  quote method.
- [ ] Return the quote, final slippage minimum, instructions, deadline, and
  signed size.
- [ ] Verify fixture-backed `aUSD -> primeUSD` and `aBTC -> primeBTC` requests
  return usable bundles through the public API.
- [ ] Cover stale NAV, pauses, caps, invalid accounts, and zero output.
- [ ] Pass the checkpoint's required checks.

**Complete when:** both direct Mint routes return fixture-backed quotes and
instruction bundles through `quoteRoutesExactIn`.

**Evidence / notes:** Pending.

## 5. Immediate Redeem quotes

- [ ] Reuse the vault readers and fee-aware calculation path.
- [ ] Require an empty observed queue, sufficient reserve for the **gross**
  claim, positive net output, and fresh NAV for the immediate payout.
- [ ] Derive the redemption entry from the same observed queue tail used during
  quoting.
- [ ] Follow the current Rust payout behavior: the TypeScript preview's comment
  about redemption freshness does not describe the immediate-fill requirement.
- [ ] Verify both direct Redeem directions against fixtures.
- [ ] Verify queued, underfunded, stale, paused, and dust cases become quote
  failures.
- [ ] Verify construction performs no second queue-tail read.
- [ ] Pass the checkpoint's required checks.

**Complete when:** direct Redeem quotes enforce the observed immediate-payout
preconditions and construct instructions from that same observed state.

**External dependency:** the pending native immediate-fill-or-abort guarantee
remains separate router/vault work. This SDK uses the existing ABI and cannot
guarantee that its preconditions survive concurrent state changes. Do not invent
a flag byte or offer queued redemption as a swap fallback.

**Evidence / notes:** Pending.

## 6. Direct CLAMM quotes

- [ ] Vendor only the required pool/tick readers, tick-selection helpers, and
  exact-input math with their source fixtures and provenance.
- [ ] Replace frontend aliases and Saturn imports with local helpers and the
  pinned Arch SDK.
- [ ] Validate pool direction, vaults, and tick accounts.
- [ ] Use three primary tick positions, zero supplements, and the quote-window
  price limit.
- [ ] Preserve repeated boundary arrays and native handling of genuinely absent
  or empty system-owned tick accounts.
- [ ] Call the native-compatible quote helper with zero per-hop slippage;
  route-level slippage is applied later.
- [ ] Require full input consumption.
- [ ] Verify both swap directions against source vectors, including fees,
  negative ticks, tick crossings, boundary repetition, and rejection of
  insufficient execution windows.
- [ ] Pass the checkpoint's required checks.

**Complete when:** both direct CLAMM directions match native-compatible vectors
and reject inputs that the selected window cannot fully consume.

**Evidence / notes:** Pending.

## 7. Graph discovery, multi-hop composition, and ranking

- [ ] Expand direct connection discovery into bounded depth-first traversal
  over configured venues: one to three hops, unique mints, and distinct parallel
  venue edges.
- [ ] Generate stable route IDs from ordered venue operations and directions.
- [ ] Quote every candidate in hop order, passing each estimated net output into
  the next hop.
- [ ] Apply slippage once to final output, then build and size-check every viable
  candidate.
- [ ] Sort successful bundles by final output descending, hop count ascending,
  then route ID; apply the limit after sorting.
- [ ] Record candidate failures with their quote/build stage. Successful
  alternatives outside the cap are not failures.
- [ ] Verify all 12 directed paths in the initial registry against fixtures.
- [ ] Verify competing venues remain distinct, longer routes can win, stable
  ties, and failed candidates preserve alternatives.
- [ ] Verify no-path and all-failed requests return valid empty results, and
  discovery excludes cycles and repeated mints.
- [ ] Pass the checkpoint's required checks.

**Complete when:** all initial routes and competing-venue fixtures produce
correctly composed, ranked, capped results with candidate failure isolation.

**Evidence / notes:** Pending.

## 8. Trustworthy receipt decoding

- [ ] Export the strict result decoder and a pure receipt helper accepting the
  Arch SDK's `ProcessedTransaction` and expected router identity.
- [ ] Require processed success and no rollback; decode the last matching
  router return log.
- [ ] Preserve program attribution when interpreting errors so a native venue's
  numeric code cannot be mislabeled as a router error.
- [ ] Keep confirmation application-owned.
- [ ] Verify measured input/output decode correctly.
- [ ] Verify queued, failed, rolled-back, malformed, missing, and wrong-program
  results cannot produce a successful receipt.
- [ ] Pass the checkpoint's required checks.

**Complete when:** successful receipts contain measured router results and all
invalid status, identity, and return-data cases fail explicitly.

**Evidence / notes:** Pending.

## 9. Package verification and frontend example

- [ ] Add an example covering account-reader normalization, one quote call,
  selection, compilation, application signing/submission, and measured receipts.
- [ ] Keep deployment selection explicit.
- [ ] Verify an installed tarball in Node and a real browser.
- [ ] Exercise PDA derivation and a fixture-backed quote in the browser with the
  small explicit `Buffer` compatibility setup required by Arch SDK 0.0.28.
- [ ] Add CI checks for typechecking, build, tests, and package contents.
- [ ] Ensure the package contains no sibling dependencies, frontend aliases, or
  undeclared imports.
- [ ] Pass the checkpoint's required checks.

**Complete when:** the packed SDK works independently of the sibling repositories
and the example demonstrates the complete application handoff.

**Evidence / notes:** Pending.

## 10. Opt-in testnet smoke coverage

- [ ] Create explicitly configured live tests, ordered direct Mint/CLAMM/Redeem,
  then two-hop and three-hop routes.
- [ ] Keep funded execution disabled by default.
- [ ] Document required configuration and test credentials without committing
  secrets.
- [ ] Report live evidence separately from fixtures.
- [ ] Pass the checkpoint's required checks without requiring funded execution.

**Complete when:** the harness and documented prerequisites exist. Live
compatibility is marked verified only for scenarios actually executed with
authorized test credentials. Completing this checkpoint does not imply all live
scenarios have run.

**Evidence / notes:** Pending.

### Live verification record

Record date, source/deployment revision, transaction reference, and observed
result for each authorized run. Leave unexecuted cases unchecked.

- [ ] Direct Mint verified live.
- [ ] Direct CLAMM verified live.
- [ ] Direct Redeem verified live.
- [ ] Two-hop routes verified live; record the directions covered.
- [ ] Three-hop routes verified live; record the directions covered.
- [ ] Missing intermediate/output ATA creation verified live.
- [ ] Tick-crossing behavior verified live.
- [ ] Runtime rollback behavior verified live.

## Boundaries and completion rules

- Keep `quoteRoutesExactIn` as the sole public swap method.
- Retain the pinned dependencies, injected account reader, and application
  ownership of refresh, deadlines, signing, submission, and retries.
- PropAMM, broader tick windows, frontend migration, deployment, and publication
  remain deferred.
- Each checkpoint must pass typechecking, build, existing tests, and its stated
  acceptance cases. Update implementation status and record evidence as
  checkpoints finish.

Required checks:

```sh
pnpm typecheck
pnpm build
pnpm test
```

Use the lockfile when installing dependencies (`pnpm install --frozen-lockfile`).
Keep fixture coverage distinct from live verification throughout the tracker.
