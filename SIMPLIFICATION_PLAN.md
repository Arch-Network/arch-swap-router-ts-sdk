# Compact SDK for fixed-pair estimates and instructions

Agreed scope: 2026-09-16. Scaffold simplification is complete; track further work in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). This plan supersedes the API
and scope of the original handover. [HANDOVER.md](HANDOVER.md) now describes the
compact SDK; all 12 fixed quote directions and route composition are complete.

## Summary

Keep one combined quote/build call and all 12 directed pairs among aBTC, aUSD,
primeBTC, and primeUSD. Each pair uses one explicit route. The SDK produces
estimates and correctly encoded instructions; the application handles the final
transaction. A receive-side sizing method now shares the same quote/build flow.

Remove graph discovery, ranking, transaction-size verification, quote timestamps,
execution preflight, and the separate top-level ATA-creation instruction.
The scaffold simplification, account reads, and quote math are complete.
Frontend examples and package/browser verification remain next.

## Public API and fixed routes

```ts
const router = createRouterClient({ source, network: "testnet" });

const swap = await router.quoteExactIn({
  inputMint,
  outputMint,
  amountIn,       // bigint, raw units
  slippageBps,
  user,           // Base58 Arch wallet public key
  deadlineMs,     // Absolute Unix milliseconds, preserved exactly
});
```

Approved addition: `quoteForOutput({ inputMint, outputMint, amountOut, slippageBps,
user, deadlineMs })` returns the same flat result. It finds a fixed input reaching
the requested output estimate using the existing exact-input math and one loaded
set of accounts. Apply slippage to the final estimate, allowing execution to
receive less than the requested amount within tolerance. Integer rounding can
produce an estimate above the target. Keep the router's exact-input ABI and the
same one-/two-batch budgets; do not add native exact-output execution.

Return one flat result:

```ts
interface SwapQuote {
  readonly inputMint: Address;
  readonly outputMint: Address;
  readonly amountIn: bigint;
  readonly estimatedAmountOut: bigint;
  readonly minAmountOut: bigint;
  /** Contains only the router instruction, including its ATA/system trailer. */
  readonly instructions: readonly Instruction[];
  readonly deadlineMs: number;
}
```

Remove `expectedSignedSize`, `quotedAtUnixSeconds`, `limit`, result arrays,
candidate failures, and public per-hop quote structures. The frontend tracks
when it receives a result and decides when to refresh. Keep `deadlineMs` for
on-chain execution expiry; it is not a guarantee of quote freshness.

Retain the injected `RouterDataSource.getAccounts(addresses)` returning ordered
`AccountInfoResult | null` values. Select a fixed deployment at client creation:
`network: "testnet" | "mainnet"`, defaulting to testnet. Keep program IDs, mints
and venues together in `src/config/networks.ts`; instantiate the fixed paths
with selected mints and pass config through loaders, derivation and construction.
Expose readonly `network`, `mints` and `supportedPairs` on the client for the
frontend. Retain existing `TESTNET_MINTS`/`SUPPORTED_PAIRS` testnet aliases.
Remove caller-supplied deployment/venue configuration and the old
`quoteRoutesExactIn` method without compatibility aliases.

Mainnet is an explicit unconfigured placeholder for now. Its client can be
created, but has null mints and an empty pair list; both quote methods reject
with `NETWORK_NOT_CONFIGURED` before any reads. Filling its config later enables
the same fixed paths without changing quote math. Never fall back to testnet.
The application supplies a reader for the selected network and recreates the
client on network changes; no SDK endpoints or mutable global network switch.

Explicitly configure both directions of these six pairs:

| Pair | Fixed path |
| --- | --- |
| aBTC ↔ primeBTC | BTC vault |
| aUSD ↔ primeUSD | USD vault |
| aBTC ↔ aUSD | CLAMM |
| primeBTC ↔ aUSD | primeBTC ↔ aBTC ↔ aUSD |
| primeUSD ↔ aBTC | primeUSD ↔ aUSD ↔ aBTC |
| primeBTC ↔ primeUSD | primeBTC ↔ aBTC ↔ aUSD ↔ primeUSD |

Lookup uses mint addresses, with ordered venue operations specified for each
direction. There is no traversal, candidate enumeration, or fallback route.
Unsupported or identical mint pairs reject with `UNSUPPORTED_PAIR` before reads.
Supported calls calculate estimates from observed state and reject if the fixed
route is unavailable. All testnet quote paths are implemented; mainnet awaits
deployment configuration.

## Validation ownership and cleanup

Remove from the SDK:

- Transaction sizing, dummy message compilation/signatures, size-specific
  errors, and dedicated size tests.
- The separate input-ATA instruction and all SDK compute-budget workarounds.
- Runtime validation of fixed route topology; cover continuity, operations, and
  unique mints in registry tests.
- Comparisons between duplicated request/quote/deployment objects. Carry one
  authoritative request and resolved step representation through the pipeline.
- Reads solely to check wallet balances, user ATA existence, program
  executability, fee-account readiness, escrow readiness, or redemption-entry
  readiness.
- Planned deadline-expiry polling, transaction-status checks, rollback
  interpretation, and expanded receipt helpers.

Keep checks needed for estimates and encoding:

- Supported pairs, valid addresses, positive `u64` input, integer slippage in
  `0..9999`, and a nonnegative safe-integer deadline.
- Account-response shape, decoding bounds, expected ownership, and relationships
  identifying the pool/vault/mints/reserves/ticks used in calculations. Missing
  accounts remain `null`; transport and malformed-response errors reject.
- Native fees, rounding, overflow behavior, and positive output. Use observed
  share supply: management fees accrue only during `Report`, not Mint/Redeem.
  Capture one internal time for Mint NAV checks; do not expose a timestamp.
- Vault pause/cap/NAV checks and immediate-redemption queue, gross-reserve
  coverage, and positive net-output requirements.
- CLAMM's three-primary-array execution window, zero supplements, and full-input
  consumption.
- Encoder integer-width checks and final slippage applied once.

Retain correct account ordering, signer/writable flags, duplicate account
positions, and the router's ATA/system trailer. Return only the router instruction;
the router creates missing input/intermediate/output ATAs. Construct SDK-owned
metadata directly instead of passing it through a generic adapter framework and
validating it again.

Compute provisioning is separate router/runtime integration work. The runtime
sets the transaction's allowance before the router executes; removing the extra
instruction does not raise that allowance. This SDK adds no compute-budget
instruction and makes no live compute claim.

Delete discovery/ranking modules, unused venue-adapter scaffolding, the quote
limit constant, and the PropAMM placeholder. Keep the existing strict result-byte
decoder internal. The application owns final transaction sizing, compilation,
signing, deadline checks around signing, submission, and confirmation.

## Account loading and implementation sequence

The implemented request budget excludes execution-only account probes:

| Selected route | SDK batches |
| --- | --- |
| Direct Mint or Redeem | 1 batch, 4 accounts |
| Direct CLAMM | 2 batches: 3 accounts, then up to 3 tick arrays |
| Vault + CLAMM, either order | 2 batches: 6 accounts, then up to 3 tick arrays |
| Redeem + CLAMM + Mint | 2 batches: 9 accounts, then up to 3 tick arrays |

For vaults, fetch vault state, required mint data, and the locally derived reserve
together. Derive fee destinations from returned recipient identities and the
redemption entry from the observed queue tail, without fetching those accounts
solely for readiness checks. Keep mutable quote inputs in fetched account state.

Native source review during checkpoint 4 corrected the original plan: Mint's
cap counts the full deposit, management fees accrue only in `Report`, and
Redeem/fill has no NAV freshness guard. See [source evidence](tests/fixtures/vault/README.md).

For CLAMM routes, load pool/vault state and known calculation inputs together,
then fetch the required tick arrays. Share batches across the selected route's
hops and deduplicate addresses within the request. Building performs no
additional reads. Each new quote call reads state again. Physical HTTP counts
depend on application-reader batching, provider limits, and fallback behavior;
batching does not establish an atomic chain snapshot.

Implementation sequence after simplifying the scaffold:

1. Validation, account loading, and vault estimates — complete.
2. CLAMM estimates and fixed-route composition — complete.
3. Frontend example and package/browser verification — next. Live smoke tests
   remain separate optional work.

Retain fixture provenance and completed codec/builder evidence. Size verification
and the extra ATA instruction were deliberately removed in checkpoint 3. Defer
one-batch prefetch optimizations, graph discovery, ranking, configurable venues,
PropAMM, and expanded receipt helpers.

Observed redemption eligibility cannot guarantee execution after concurrent
state changes. Keep the current ABI while native immediate-fill-or-abort support
is pending; do not invent a flag or offer queued redemption as a swap fallback.

## Verification and defaults

- Test all 12 directed registry entries and their expected ordered operations.
- Verify unsupported pairs reject before reads and all 12 supported directions
  match native estimates, instruction construction, and shared read budgets.
- Preserve Rust-derived instruction-byte, account-order, privilege,
  duplicate-position, PDA, and codec coverage. Compare the router instruction
  inside the original two-instruction fixtures and retain the ATA/system trailer.
- Remove tests whose sole purpose is size enforcement or runtime checks replaced
  by fixed-registry tests. Keep original fixture data and provenance.
- Run typecheck, build, and the remaining suite. Verify public declarations and
  examples contain no quote timestamp, ranking, candidate-list, size-verification,
  or guaranteed-execution contract.

Defaults: testnet (mainnet selectable but unconfigured), exact-input execution with either input or receive-side sizing,
wallet required for the combined call, pinned
Arch SDK dependencies, no new dependencies, no frontend migration, and no live
transactions in the scaffold simplification pass.
