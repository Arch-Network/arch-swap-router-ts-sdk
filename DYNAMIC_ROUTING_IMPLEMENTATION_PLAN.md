# Minimal TypeScript graph routing: implementation plan and handoff

Status: All six steps and the two-call follow-up have been implemented and tested
offline. Typecheck, build, and 846 offline tests pass. The last live run, before
the batching follow-up, passed 13/14 directions; aUSD → aETH remains blocked
by a mismatch between the server's deployment and the SDK's pinned registry.
See the Step 6 results below for evidence and the remaining external action.
Follow-up: the account-loading budget is now at most two reader calls per quote,
including RFQ-enabled vault/swap routes. The two-call follow-up log below
supersedes earlier three-call budgets.

## Goal and agreed decisions

Replace the SDK's explicit pair-to-path table with bounded TypeScript graph
traversal. Reuse existing quote math, RFQ providers, account validation, and
transaction builders. Keep the changes small enough to review and ship together.

The user explicitly selected:

- Keep the current **14 directed pairs**, rather than adding aETH cross routes.
- Keep the current **two-second RFQ timeout**, rather than adding an earlier
  selection deadline.

Other implementation defaults agreed in the plan:

- Use a small typed adjacency list and bounded depth-first traversal. No new graph
  dependency, Dijkstra implementation, or static quote weights are needed.
- Keep existing public request, provider, client, and quote-result interfaces.
- Keep the on-chain limit of **three hops and at most one PropAMM RFQ**.
- No server, Rust program, frontend, deployment, or dependency changes are planned.
- No persistent warm cache, background service, split routes, automatic market
  discovery, additional synthetic markets, or multiple-RFQ execution in this phase.

The graph finds possible executable paths. Amount-specific quote evaluation
chooses the best one; rates are not constant edge weights.

## Starting point and source of truth

Inspected on 2026-11-02 in `~/Arch/arch-swap-router-ts-sdk`, at commit `fc6c4ef`
(`Added aETH <-> aUSD smoke test`). The checkout was clean before this document.
Recheck HEAD and local changes before implementation; preserve subsequent work.

| Source | What to reuse or change |
| --- | --- |
| [src/client.ts](src/client.ts) | Request validation, graph candidate discovery, request-local preparation/evaluation dispatch, and the separate aETH path. |
| [src/quote-state.ts](src/quote-state.ts) | Request-local preparation of graph candidates, memoized decoded vaults, and isolated lazy CLAMM preparation. |
| [src/quote-candidates.ts](src/quote-candidates.ts) | Common-prefix validation, hop-by-hop candidate evaluation, quote construction, transaction eligibility, freshness checks, ranking, and failure aggregation. |
| [src/config/routes.ts](src/config/routes.ts) | Internal deployment graph, bounded candidate enumeration, reachability-derived pair metadata, and graph-generated testnet paths. |
| [src/config/networks.ts](src/config/networks.ts) | Existing network-specific mints, venues, and BTC/USD PropAMM deployment. Keep these as the registry. |
| [src/config/aeth-usd.ts](src/config/aeth-usd.ts) | Current mainnet ETH deployment and decimals. |
| [src/vault.ts](src/vault.ts) | Vault state validation, fees, rounding, supply/reserve math, and resolved account derivations. |
| [src/clamm.ts](src/clamm.ts) | Pool validation, tick-window derivation, tick decoding, and exact-input simulation. |
| [src/propamm.ts](src/propamm.ts) | Existing RFQ validation, expiry, timeout, and account resolution. |
| [src/direct-rfq.ts](src/direct-rfq.ts) | Strict validation of original aETH server transactions; preserve this contract. |
| [src/transactions/instructions.ts](src/transactions/instructions.ts) | Canonical instruction/account layout and RFQ bundle. |
| [src/transactions/size.ts](src/transactions/size.ts) | Shared byte/account limit guard with every header-required signature slot reserved. |
| [src/utils.ts](src/utils.ts) | Account reader and request-local in-flight deduplication, address/PDA helpers, input sizing, and canonical message compilation. |
| [src/types.ts](src/types.ts), [src/index.ts](src/index.ts) | Existing public API and exports to preserve. |

The installed `@arch-network/arch-sdk` is **0.13.0**. Its runtime constants are
`RUNTIME_TX_SIZE_LIMIT = 4096` and `MAX_ACCOUNTS_PER_TRANSACTION = 50`.
Use dependency constants rather than another hardcoded limit.

The sibling Rust router already executes the supported venue steps generically.
Its `src/instruction.rs` and `src/accounts.rs` both enforce three hops and one
PropAMM step. The SDK encoder enforces the same bounds. No wire-format change is
needed. Keep the executor's measured intermediate credits, exact debits, and
final minimum-output protection unchanged.

Older handoffs describe historical branches, IDs, fixed-route restrictions, or
the old 1,232-byte limit. Current source and this plan govern this task. Do not
copy legacy PDA seeds or deployment IDs from those documents.

## Supported paths and compatibility

Preserve all twelve directed pairs among aBTC, aUSD, primeBTC, and primeUSD:

| Pair, in both directions | Path |
| --- | --- |
| aBTC <-> primeBTC | BTC vault mint/redeem |
| aUSD <-> primeUSD | USD vault mint/redeem |
| aBTC <-> aUSD | CLAMM or optional PropAMM |
| primeBTC <-> aUSD | BTC vault plus asset swap |
| primeUSD <-> aBTC | USD vault plus asset swap |
| primeBTC <-> primeUSD | Vault redemption, asset swap, vault mint |

With the mainnet `directRfqQuoteProvider`, also preserve aETH <-> aUSD, giving
fourteen directed pairs. Without that provider, or on testnet, preserve the
existing twelve-pair behavior. BTC/USD RFQ edges are available only when the
matching provider and network deployment are configured.

The aETH pair is a separate execution capability: buys use a treasury mint and
sells use a native PropAMM transaction. These are complete server-built messages,
not composable router instructions. The smallest implementation keeps the
existing aETH dispatcher and validators and combines its pair metadata with the
graph-generated core pairs. Do not splice these transactions into graph paths.

`quoteForOutput` remains approximate receive sizing for the twelve core pairs,
using only vault/CLAMM paths. It must never invoke an RFQ provider. aETH receive
sizing and cross routes remain unsupported.

## Implementation checklist

### 1. Build the internal graph and enumerate candidates

- [x] Replace explicit path enumeration with directed edges built from the
  selected network's existing venue registry.
- [x] Keep the graph internal. Use mint addresses as node keys and stable
  venue/operation/direction IDs as edge identities; distinguish parallel CLAMM
  and PropAMM edges between aBTC and aUSD.
- [x] Add vault mint/redeem edges in both asset/share directions, CLAMM edges in
  both swap directions, and optional BTC/USD RFQ edges.
- [x] Enumerate simple paths for the requested input/output pair, stopping at
  the destination and rejecting repeated mints, more than three hops, or more
  than one PropAMM edge. Filter RFQ edges out for receive sizing.
- [x] Derive unique, immutable core supported-pair metadata from reachability;
  preserve the public testnet `SUPPORTED_PAIRS` export and existing client
  metadata shapes. Do not introduce another manually maintained pair table.

Acceptance: all twelve existing core directions are found, no identical-mint or
unsupported pair becomes available, and current swap-bearing pairs have at most
two venue candidates. No account/RFQ calls are required for graph construction.

### 2. Reuse account preparation within each quote request

- [x] Load only the accounts needed by the candidate paths for this request.
- [x] Share loaded accounts and decoded state across candidates using a
  request-local map; do not keep mutable account state across quote requests.
  Use staged shared preparation or memoized in-flight reads so concurrent
  evaluators cannot fetch the same address twice. Cache confirmed `null` results
  within the request too, while preserving batching and failure isolation.
- [x] Capture the vault pricing timestamp once, before asynchronous account
  reads, as the current implementation does. Keep that timestamp separate from
  fresh wall-clock reads used to check RFQ expiry during selection.
- [x] Preserve shared-vault preparation before an RFQ whose input depends on a
  vault redemption. Quote the swap using the redemption's net asset output.
- [x] Preserve CLAMM-specific fetch/validation isolation. A pool/tick failure
  must not invalidate an otherwise usable RFQ; shared-vault failure still
  prevents paths requiring that vault. Share decoded/validated vault state, but
  evaluate amount-dependent constraints within each candidate. A destination
  vault's deposit cap can reject a larger RFQ output while accepting a smaller
  CLAMM output. Common redemption-prefix failures can still fail the request
  before either swap candidate runs.
- [x] Use at most two account-reader calls per quote, including RFQ-enabled
  vault/swap routes. Batch known accounts together, isolate per-account failures,
  and preserve RFQ fallback within the same budget.

Acceptance on successful account-loading paths: vault-only routes read once;
CLAMM paths read twice, with or without RFQ enabled. Earlier failures may use
fewer reads. No successfully read address is fetched twice within one request,
including overlapping concurrent loads or confirmed absence. If an entire
initial batch fails transport or framing with RFQ enabled, use the second call
only to recover required vault accounts, retaining the CLAMM failure without
loading ticks. Confirmed invalid shared accounts fail without recovery. The two
ETH directions still perform no SDK account reads.

### 3. Evaluate paths and select the winning quote

- [x] Reuse `prepareVaultQuote`, `loadClamm`/`prepareClammQuote`, `quotePropAmm`,
  and `inputForOutput`; do not rewrite venue pricing or rounding.
- [x] Evaluate independent candidates concurrently. Within a path, pass each
  hop's estimated output into the next hop and preserve bigint raw units.
- [x] For `quoteExactIn`, select the highest final estimated output after
  venue/vault fees among fully valid candidates. For `quoteForOutput`, minimize
  the valid input needed to reach the requested estimated output before
  slippage. The current graph has only one non-RFQ path per core pair. Keep
  CLAMM's existing preference on equal exact-input output and deterministic
  ordering for any remaining ties.
- [x] For router quotes, apply slippage once at the final output. Preserve
  original RFQ terms, quote ID, maker identity, and the minimum of request/quote
  expiry. Preserve aETH's existing validators and signed minimum-output behavior.
- [x] Recheck RFQ freshness after all candidates settle. Preserve the two-second
  timeout, timer cleanup, no retries, and failure isolation.
- [x] Preserve request-validation, unsupported-pair, and shared-state errors;
  use `NO_ROUTE` when competing venue candidates are exhausted. Do not replace
  every actionable account error with a generic route failure. Follow the error
  policy below, including transaction-limit failures.
- [x] Keep receive sizing local to loaded vault/CLAMM state, with existing
  minimal-input and unreachable-target behavior.

Acceptance: exact-input final output decides the winner, including a vault
suffix; receive sizing selects the smallest valid input. A stale, declined,
malformed, or failed RFQ leaves CLAMM available, and a CLAMM failure leaves RFQ
available when shared state is valid. Candidate-specific vault suffix failures
do not invalidate another candidate whose amount satisfies that vault's limits.

Error policy (without changing the public quote union):

| Failure | Result |
| --- | --- |
| Invalid request or unsupported pair | Preserve the existing error before network calls. |
| Shared account loading/validation or a common redemption prefix fails | Preserve the actionable underlying error. |
| The only instruction-based candidate fails | Propagate its underlying error, including `TRANSACTION_TOO_LARGE` or `TRANSACTION_TOO_MANY_ACCOUNTS`. |
| Competing venue candidates all fail eligibility, pricing, or freshness | Throw `NO_ROUTE` with an `AggregateError` cause retaining each candidate's failure, including size/account-limit errors and expiry. |
| An aETH provider, validator, or transaction-limit check fails | Propagate the error; there is no alternate execution path. |

### 4. Check executable transaction limits before selection

- [x] Reuse existing resolved steps, canonical builders, and RFQ account
  ordering. Preserve the exact bundle for each mode: vault/CLAMM quotes return
  `[router]`, PropAMM router quotes return `[input ATA, router]`, and aETH quotes
  return the original server transaction. Do not add compute instructions.
- [x] Compile each otherwise valid instruction-based candidate with a 32-byte
  placeholder blockhash and reserve all signatures indicated by its header.
- [x] Enforce serialized bytes <= `RUNTIME_TX_SIZE_LIMIT` and compiled unique
  account keys <= `MAX_ACCOUNTS_PER_TRANSACTION`, including program keys.
- [x] Exclude an over-limit candidate before choosing the winner; retain a
  smaller eligible alternative. Do not compare the number of fetched accounts
  with the transaction's account limit. Report exhausted candidates using the
  error policy in Step 3.
- [x] For aETH, measure the original validated message with both required
  signature slots reserved. Do not recompile or replace its blockhash.
- [x] Retain caller responsibility to recheck the final transaction if the
  application appends instructions. No blockhash RPC is needed for size checks.

Acceptance: every returned SDK bundle fits both dependency limits; signature
bytes and the complete account list are counted for all execution modes.

### 5. Integrate and document without changing consumers

- [x] Route existing public quote calls through candidate discovery/evaluation;
  keep client options, request fields, provider contracts, and quote union intact.
- [x] Keep `RouterSwapQuote.instructions`/optional `rfq.quoteId` and
  `ServerTransactionSwapQuote.transaction` behavior unchanged.
- [x] Preserve network isolation, provider opt-in, frozen pair metadata, and
  early request/unsupported-pair validation before network calls.
- [x] Update README and test documentation for graph-generated paths, unchanged
  supported pairs, quote selection, read budgets, and transaction limits.
- [x] Avoid a general adapter/plugin framework or public graph configuration.

### 6. Validate and record results

- [x] Reuse independent Rust/native fixtures to prove all twelve core paths
  retain venue order, math, instruction bytes, account order, and privileges.
- [x] Add graph tests for parallel venues, missing paths, repeated mints/cycles,
  hop/RFQ bounds, network selection, and pair metadata.
- [x] Cover final-output ranking, RFQ inputs after redemption, vault suffixes,
  ties, timeout cleanup, expiry after slower reads, and both fallback directions.
  Include an RFQ output rejected by a destination-vault cap while the smaller
  CLAMM candidate remains eligible.
- [x] Retain receive-sizing coverage for all twelve core directions, bigint
  precision, unreachable targets, and absence of RFQ calls.
- [x] Assert deduplicated per-request reads, current batch budgets, fresh state
  on later calls, and no SDK account reads on the ETH path. Cover overlapping
  in-flight reads, confirmed absence, one captured vault-pricing timestamp, and
  independent fresh RFQ-expiry checks.
- [x] Cover 4,096/4,097 bytes with one and two signatures and 50/51 unique
  accounts. Exercise candidate rejection/fallback at the limit-check boundary
  with synthetic transactions; current native route fixtures may fit all limits.
  Assert single-candidate limit errors and aggregate causes when every competing
  candidate is rejected; measure the existing bundle for each execution mode.
- [x] Retain both ETH validators, unchanged original messages, execution-mode
  narrowing, quote IDs, signed minima, and unsupported cross-pair rejection.
- [x] Run typecheck, offline suite, and build, then quote-only live smoke tests.
- [x] Record commands/results and remaining external blockers below; distinguish
  quote construction from successful funded execution.

## Account-fetch reference

| Venue | Required quote reads | Derived or transaction-only references |
| --- | --- | --- |
| Each vault | Vault state, underlying mint, share mint, reserve token account | Fee-share ATAs, event authority, escrow and redemption entry |
| CLAMM | Pool, both mints, up to three directional tick arrays | Token vault addresses from pool; oracle PDA |
| PropAMM | No additional SDK RPC reads for pricing; injected provider returns RFQ | Config, maker, inventory vaults, nonce and user ATAs are resolved by existing code |
| aETH server RFQ | No SDK RPC reads; injected provider returns complete transaction | Original transaction accounts validated by existing normalizers |

Deduplicating both vaults plus CLAMM gives nine initial accounts and up to three
tick arrays for one current three-hop candidate: at most twelve unique quote
account reads. This is not the total transaction account count. Only request the
relevant subset, not every market or both tick directions globally.

Keep account owner/mint/PDA and initialization checks. `RouterDataSource` must
preserve response order and normalize owner/data to `Uint8Array`; a transport
failure rejects, while `null` means confirmed account absence. For CLAMM ticks,
retain current native handling of absent/empty system accounts. Never silently
convert an RPC failure into an empty tick array.

Reserve seeds are `["reserve", shareMint]` under the vault program. Tick-array
seeds are `["tick_array", pool, decimalStartTickText]` under CLAMM; derive them
from current pool state. Reuse helpers instead of inventing alternate encodings.
Vault redemption entries depend on the observed queue tail.

Addresses/decimals are registry metadata, but share-mint supply, reserve balances,
vault NAV/fees/queue/status, and CLAMM pool/ticks are mutable pricing state. Do not
cache an entire share-mint account indefinitely just because decimals are stable.

## Deployment and test reference

Use existing SDK configuration and fixtures as the authoritative deployment
registry. Relevant mainnet identities are:

| Item | Value |
| --- | --- |
| RPC | `https://rpc.mainnet.arch.network` |
| PropAMM RFQ base | `https://vaults.veloxapi.net/propamm/rfq` |
| Router program | `Bu8JuhykFEtJmUqYV98zJDtPr2J7LBMbEJX8DeT7XSeT` |
| Vault program | `BtPdgu3v6ruKYbhiuGLEx7Fa4rU6f15maftGhNRTP32L` |
| CLAMM program | `AzvVQ4qV2DnokUgtxskJ2V11BP5M5Fvx51G3aUgnZm7A` |
| PropAMM program | `5KMw4VNavLhM5wxTxyQGm8hs5ymFhqMCZ5BpkHybcEBV` |
| PropAMM config | `3jwSNH8P5tNFMY72ZwFi5z3gEkK1vVor3xcAFvr4DHzr` |
| aETH mint | `7g1nPCjKW7zzZ4q7mcABeFXaPSLfBQ6syrz4HnPGAVYt` (**9 decimals**) |

Do not restore the old aETH mint/6-decimal metadata from early conversation
examples. Source support for config v4 does not prove the live account's version;
this planning task does not upgrade config or assert live server readiness.

Useful existing tests: `tests/config/routes.test.ts`, `tests/client.test.ts`,
`tests/vault.test.ts`, `tests/clamm.test.ts`, `tests/propamm.test.ts`,
`tests/direct-rfq-client.test.ts`, `tests/transactions/`, and
`tests/quote.e2e.test.ts`. See [tests/README.md](tests/README.md) for provenance
and the current live smoke-test contract.

From the SDK repository:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Keep `ARCH_RPC_URL` unset for the offline run. Then run the existing read-only
mainnet smoke suite separately:

```sh
ARCH_RPC_URL=https://rpc.mainnet.arch.network \
  corepack pnpm exec vitest run tests/quote.e2e.test.ts
```

The live suite covers all fourteen directions with dummy-user unsigned quotes.
Its BTC/USD HTTP adapter already has a 1.8-second HTTP abort inside the SDK's
two-second RFQ timeout. Keep these current budgets. Live liquidity, inventory,
NAV freshness, queues, or connectivity can prevent quotes; report such failures
without weakening tests or treating silent fallback as successful RFQ coverage.
Do not sign, submit, deploy, publish, or commit as part of this implementation.

## Progress and handoff log

- [x] Confirmed initial pair scope and timeout choice with the user.
- [x] Inspected current SDK implementation and Rust hop/RFQ bounds.
- [x] Exported the implementation plan and handoff.
- [x] Incorporated review clarifications on selection objectives, execution-mode
  bundles, vault suffix constraints, concurrent read deduplication, error policy,
  and clock semantics.
- [x] Step 1: graph and candidate discovery.
- [x] Step 2: request-local account preparation.
- [x] Step 3: candidate evaluation and selection.
- [x] Step 4: transaction eligibility checks.
- [x] Step 5: public integration and documentation.
- [x] Step 6: offline and live quote-only validation executed; one live
  deployment compatibility blocker documented below.

### Step 1 results

- Replaced the twelve explicitly enumerated paths with a typed adjacency list
  built from venue endpoints. Edge IDs include venue identity and operation or
  direction. DFS excludes repeated mints, paths over three hops, and paths with
  more than one RFQ. Receive-sizing discovery excludes RFQ edges.
- Added optional BTC/USD PropAMM graph edges behind an explicit RFQ-enabled
  flag and a configured deployment. Both networks retain twelve core pairs;
  swap-bearing pairs have one CLAMM and one RFQ candidate when enabled.
- The client now discovers its non-RFQ path through the graph. Its existing
  shared-account preparation and CLAMM/RFQ replacement evaluator remain in place
  until Steps 2–3; graph RFQ candidates are not yet passed to a generic evaluator.
- `SUPPORTED_PAIRS` and client pair metadata are frozen and derived from bounded
  reachability. Pair order follows deterministic graph node order; the pair set
  and metadata shapes are unchanged. The existing aETH dispatcher still adds
  only the two mainnet direct pairs when its provider is configured.
- Added independent native-path checks for both networks and synthetic graph
  cases for cycles, disconnected pairs, three/four-hop boundaries, and one/two-RFQ
  boundaries. Updated README/test documentation for the completed graph layer.

Validation:

| Command | Result |
| --- | --- |
| `corepack pnpm typecheck` | Passed. |
| `env -u ARCH_RPC_URL node_modules/.bin/vitest run tests/config/routes.test.ts tests/client.test.ts tests/clamm.test.ts tests/propamm.test.ts tests/direct-rfq-client.test.ts` | Passed: 302 tests across 5 files; graph coverage includes 29 tests. |
| `env -u ARCH_RPC_URL corepack pnpm test` | Passed: 781 tests across 18 files; 14 live smoke cases skipped. Existing native math, instruction/account bytes, RFQ fallback, read-budget, receive-sizing, and aETH checks pass. |
| `corepack pnpm build` | Passed. |

No blocking questions arose during Step 1. Live smoke tests are deferred to
Step 6 after candidate preparation/evaluation and eligibility checks are wired
together. No signing, submission, deployment, publishing, or commits performed.

### Step 2 results

- Added `prepareQuoteState` in `src/quote-state.ts`. It prepares only accounts
  required by this request's graph candidates, shares decoded vault quotes by
  edge ID, and memoizes lazy CLAMM preparation and failures by edge ID.
- The client now enables graph RFQ edges when its provider is configured and
  passes all discovered candidates to preparation. Receive sizing filters RFQ
  edges before preparing state. The existing candidate-specific quote evaluators
  and final selection remain in place for migration in Step 3.
- Added a request-local account loader that shares pending and completed reads,
  confirmed absence, and rejected reads. Overlapping calls batch only addresses
  that have not already been requested; empty loads make no source call. A new
  quote creates a new loader and fresh decoded venue state, including mint supply.
- Preserved staging: vault-only paths use one batch; CLAMM paths without RFQ use
  two; direct competing swaps use two; competing swaps with a vault use three.
  Shared vault reads exclude the CLAMM pool when RFQ is enabled, so pool/tick
  failures cannot discard valid shared state or prevent an RFQ candidate.
- Preserved one vault-pricing timestamp captured before account reads, the net
  redemption input supplied to RFQ, fresh RFQ-expiry checks at selection, and
  both aETH directions' zero SDK account reads.
- Added regressions for overlapping in-flight reads, cached null/failure results,
  fresh state after success/failure, shared decoded vault/CLAMM quotes, and both
  directions of destination-vault-cap fallback. Common redemption-prefix failures
  still surface before RFQ calls; suffix amount checks remain candidate-specific.

Validation:

| Command | Result |
| --- | --- |
| `corepack pnpm typecheck` | Passed. |
| `env -u ARCH_RPC_URL node_modules/.bin/vitest run tests/quote-state.test.ts` | Passed: 5 preparation tests after correcting two new fixture inputs that rounded to zero under native redemption fees. |
| `env -u ARCH_RPC_URL corepack pnpm test` | Passed: 792 tests across 19 files; 14 live smoke cases skipped. Includes all existing quote math, instruction/account bytes, read budgets, fallback, receive-sizing, and aETH checks. |
| `corepack pnpm build` | Passed. |
| `node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --resolveJsonModule tests/quote-state.test.ts tests/utils.test.ts` | Passed: additional strict checking of the new preparation tests and updated loader tests. |

An optional strict check also including `tests/propamm.test.ts` reports existing
`SwapQuote.instructions` union-narrowing errors in that runtime test file. The
repository's standard typecheck excludes ordinary runtime tests and passes; this
existing test-typing cleanup is outside Step 2. No blocking implementation
questions arose. Live smoke tests remain deferred to Step 6.

### Step 3 results

- Replaced the separate CLAMM evaluator and RFQ path substitution with
  `quoteCandidates` in `src/quote-candidates.ts`. The client passes every graph
  candidate through the same hop-by-hop evaluator using request-local prepared
  state and existing venue pricing. All amounts and comparisons stay in bigint
  raw units, and each hop consumes the preceding hop's estimated output.
- Common vault prefixes are checked once before competing candidates start,
  preserving actionable redemption errors and the RFQ's net asset input. Their
  prepared results are reused by both candidates. Remaining path steps evaluate
  independently and concurrently; candidate-specific suffix failures retain the
  other venue as a fallback.
- Exact-input selection ranks final estimated output after all venue/vault fees.
  CLAMM wins equal output even if an RFQ candidate appears first. Receive sizing
  loads local estimators once, reuses `inputForOutput`, and minimizes valid input
  with stable ordering on ties. RFQ paths cannot call the provider in receive
  sizing, including a defensive check inside the evaluator.
- Preserved final-only slippage, original RFQ terms/ID/maker, effective expiry,
  unchanged instruction bundles, and the separate aETH server-message path.
  Validated request fields are captured before asynchronous preparation.
- Candidates settle concurrently before RFQ freshness is checked with a fresh
  clock read. The existing two-second RFQ timeout, timer cleanup, no retries,
  and both fallback directions remain covered. A sole failed candidate propagates
  its original error; exhausted competing candidates return `NO_ROUTE` with
  original causes retained in candidate order, including selection-time expiry.
- Added eight evaluator regressions for reversed-order ties, concurrent venue
  progress, aggregate/sole-candidate errors, minimum-input and tie selection for
  synthetic local paths, RFQ-free receive sizing, and request snapshot stability.
  Strengthened the existing stale-RFQ test to verify its aggregate expiry cause.

Validation:

| Command | Result |
| --- | --- |
| `corepack pnpm typecheck` | Passed. |
| `env -u ARCH_RPC_URL node_modules/.bin/vitest run tests/client.test.ts tests/vault.test.ts tests/clamm.test.ts tests/propamm.test.ts tests/quote-state.test.ts tests/direct-rfq-client.test.ts` | Passed: 354 existing quote/preparation tests across 6 files. |
| `env -u ARCH_RPC_URL node_modules/.bin/vitest run tests/quote-candidates.test.ts tests/propamm.test.ts` | Passed: 78 tests across 2 files, including all 8 new evaluator cases. |
| `env -u ARCH_RPC_URL corepack pnpm test` | Passed: 800 tests across 20 files; 14 live smoke cases skipped. Native quote math and instruction/account bytes, all core receive-sizing paths, read budgets, RFQ terms/fallback/timeout behavior, and aETH contracts pass. |
| `corepack pnpm build` | Passed. |
| `node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --resolveJsonModule tests/quote-candidates.test.ts` | Passed: additional strict checking of the new evaluator tests. |

No blocking questions arose. Uniform byte/account eligibility checks remain for
Step 4; existing RFQ builder guards are retained. Live quote-only smoke tests
remain deferred to Step 6. No signing, submission, deployment, publishing, or
commits performed.

### Step 4 results (2026-11-03)

- Added `assertMessageLimits` in `src/transactions/size.ts`. It measures the full
  version-0 transaction using the original compiled message and reserves all
  signature slots required by its header. It enforces dependency-supplied byte
  and account-key limits, including program keys, without mutating the message.
  Byte-limit errors retain priority when a message exceeds both limits.
- Vault/CLAMM candidates compile their exact `[router]` bundle with a 32-byte
  placeholder blockhash and pass the guard before they become eligible for
  selection. The existing PropAMM builder applies the same guard to its exact
  `[input ATA, router]` bundle after its signer checks. Each valid router
  candidate compiles and measures once; no account or blockhash reads were added.
- Both aETH normalizers apply the same byte/account guard to the original server
  message, with its two required signature slots reserved. They preserve the
  transaction, signature array, account order, and server blockhash.
- An over-limit candidate is rejected independently. Another eligible venue can
  win despite a smaller estimate. Sole candidates propagate their limit error;
  exhausted competing candidates retain byte/account errors in `NO_ROUTE`'s
  aggregate cause, using the Step 3 policy.
- Added 25 offline cases: eight shared-guard cases for signature reservation,
  byte/account boundaries and program-key/deduplication behavior; fifteen
  evaluator cases for both venues' eligibility boundaries, fallback, aggregate
  errors, receive sizing, and vault-only public quotes; and one 51-key case for
  each aETH direction. Synthetic compiled messages exercise the boundary because
  existing native fixtures fit both limits. Native wire fixtures remain intact.
- Updated caller guidance to recheck final router transactions after appending
  instructions. Added account-limit assertions to the existing live smoke suite;
  those assertions await the Step 6 quote-only run.

Validation:

| Command | Result |
| --- | --- |
| `corepack pnpm typecheck` | Passed. |
| `env -u ARCH_RPC_URL node_modules/.bin/vitest run tests/transactions/size.test.ts tests/quote-candidates.test.ts tests/transactions/propamm.test.ts tests/direct-rfq.test.ts tests/direct-rfq-sell.test.ts tests/direct-rfq-client.test.ts` | Passed: 261 tests across 6 files. |
| `env -u ARCH_RPC_URL corepack pnpm test` | Passed: 825 tests across 20 files; 14 live smoke cases skipped. Native instruction/message bytes, signature roles, fallback, read budgets, deadlines, and receive sizing pass. |
| `env -u ARCH_RPC_URL node_modules/.bin/vitest run tests/quote.e2e.test.ts` | After adding account-limit assertions, the file loads successfully with all 14 live cases skipped; no live RPC/RFQ calls made. |
| `corepack pnpm build` | Passed. |
| `node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --resolveJsonModule tests/transactions/size.test.ts tests/quote-candidates.test.ts tests/direct-rfq.test.ts tests/direct-rfq-sell.test.ts` | Passed: additional strict checking of the changed limit tests. |

No blocking questions arose. Step 5's integration/documentation audit and Step 6's
final validation/live quote-only run remain. No signing, submission, deployment,
publishing, or commits performed.

### Step 5 results (2026-11-03)

- Audited both public quote methods through discovery, request-local preparation,
  common evaluation, eligibility checks, and selection. The mainnet aETH dispatcher
  remains separate. No production-code changes were needed for this audit.
- Compared `src/types.ts`, `src/index.ts`, `package.json`, and `pnpm-lock.yaml`
  against baseline `fc6c4ef`: all are unchanged. Public client options, request
  fields, provider contracts, quote union, dependency pins, package privacy, and
  the root-only exports map are preserved. Graph helpers remain package-internal.
- Updated README/test documentation for the completed graph pipeline, 12/14-pair
  opt-in scope, frozen capability metadata, mint-based pair selection, healthy
  read budgets and early failures, final-output/minimum-input ranking, vault
  suffix isolation, transaction limits, and consumer ownership of submission.
- Removed obsolete documentation that described the config as v2-only or directed
  consumers to perform a migration. The checked-in mainnet snapshot records v3;
  source support for later layouts is not a claim about the current live version.
  Corrected the test documentation's aETH decimals to 9 and retained aUSD at 6.
  Older handoffs are explicitly historical references, with this plan/current
  source governing the routing migration.
- Built and packed a private tarball under `/tmp/arch-router-step5/sdk.tgz`.
  It contains 82 files restricted to `dist/`, README, and package metadata. A
  temporary external consumer uses the unpacked SDK and links only its two
  declared, already-installed runtime dependencies; no install or network access
  is required. This does not test a fresh registry dependency installation.
- Verified all seven runtime root exports and three blocked private subpaths.
  Compiled the existing consumer type/narrowing checks against the packed
  declarations, plus negative assertions for public graph factories, graph
  options, and steps in supported-pair metadata.
- Exercised 34 fixture quote flows in Node 22.23.1 and in an ES2022 browser-targeted
  bundle: 12 core exact-input routes, 12 receive-sizing routes, 8 router RFQ paths,
  and both mainnet aETH server transactions. Both environments also pass all
  8 provider/network metadata combinations and 24 early-validation cases, with
  frozen metadata and no account/provider calls on invalid requests.
- Browser-bundle execution uses an isolated V8 context without `process`,
  `Buffer`, or `require`; it does not launch an actual browser or a consuming
  frontend. Results match Node, including quote amounts, signer counts, packet
  bytes, and account counts. aETH preserves original transaction references and
  bytes; core quotes preserve their existing instruction/optional-RFQ shapes.
  Transport is disabled and no network calls occur. Bundle inputs use the packed
  entry point and declared dependencies, with no checkout source/test aliases.

Validation:

| Command | Result |
| --- | --- |
| `corepack pnpm typecheck` | Passed, including existing public consumer type contracts. |
| `corepack pnpm build` | Passed. |
| `env -u ARCH_RPC_URL node_modules/.bin/vitest run tests/client.test.ts tests/direct-rfq-client.test.ts tests/examples/aeth-usd.test.ts tests/config/routes.test.ts` | Passed: 156 focused public API, metadata, example, and graph tests across 4 files. |
| `corepack pnpm pack --out /tmp/arch-router-step5/sdk.tgz --json > /tmp/arch-router-step5/pack.json` | Passed: local private archive created; nothing published. |
| `node /tmp/arch-router-step5/verify.mjs` | Passed: packed Node/browser-targeted smoke runs, matching 34-flow results per environment, provider/validation matrix, private subpaths, and strict packed-consumer typecheck. Results: `/tmp/arch-router-step5/results.json`; reusable audit scripts and extracted consumers remain in that temporary directory. |

The first temporary audit attempt hit the environment's synchronous child-process
restriction. Switching the audit harness to asynchronous process calls completed
the same local checks successfully; no SDK changes or extra permissions were
needed. Step 4's 825-test full offline suite remains the most recent full run;
Step 5 changed documentation only and uses the focused/packed checks above.

No blocking questions arose. Step 6 remains for the final full offline suite and
live quote-only smoke tests. Real-browser frontend integration is outside this
routing migration. No signing, submission, deployment, publishing, or commits
performed.

### Step 6 results (2026-11-03)

Final offline validation passes. Live quote-only validation passes **13 of 14
directions**, with **no live cases skipped**. All twelve core directions and
aETH → aUSD pass. aUSD → aETH fails strict server-message validation because the
server returns a different treasury authority and bridge program from the SDK's
pinned deployment. This remains an external compatibility blocker; the suite
does not pass in full.

Validation commands were run from the SDK root. Logs and JSON reports are in
`/tmp/arch-router-step6/`; the table abbreviates report paths to filenames.

| Command | Result |
| --- | --- |
| `corepack pnpm typecheck` | Passed, including the public consumer type contracts. Log: `typecheck.log`. |
| `env -u ARCH_RPC_URL -u ARCH_RFQ_URL corepack pnpm test --reporter=default --reporter=json --outputFile=/tmp/arch-router-step6/offline.json` | Passed: **825 tests across 20 files**; 14 live cases skipped as intended for this offline run. Reports: `offline.log`, `offline.json`. |
| `corepack pnpm build` | Passed. Log: `build.log`. |
| `git diff --check` | Passed. |
| `git diff --exit-code fc6c4ef -- src/types.ts src/index.ts src/config/networks.ts src/config/aeth-usd.ts package.json pnpm-lock.yaml` | Passed: public types/exports, network and aETH registries, package metadata, and dependency lock remain unchanged from baseline. |
| `env -u ARCH_RFQ_URL ARCH_RPC_URL=https://rpc.mainnet.arch.network corepack pnpm exec vitest run tests/quote.e2e.test.ts --reporter=default --reporter=json --outputFile=/tmp/arch-router-step6/live-network.json` | **13 passed, 1 failed, 0 skipped**, starting at `2026-11-03T00:31:20.104Z`. Reports: `live-network.log`, `live-network.json`. |
| `node /tmp/arch-router-step6/replay-aeth-buy.mjs` | The captured buy response fails both the baseline `fc6c4ef` buy validator and current validator with identical `INVALID_RFQ` errors. Report: `aeth-buy-replay.json`. |

The first live attempt inside restricted execution failed all fourteen cases
with DNS `EAI_AGAIN` errors. The network-enabled retry above supersedes those
connectivity results; the initial attempt remains in `live.log`/`live.json`.
No timeout, retry, fallback, or assertion changes were made to obtain coverage.

Offline coverage retained by the final run:

- Independent Rust/native fixtures for all twelve core paths, quote math,
  instruction bytes, account order/privileges, and complete PropAMM messages.
  The graph, candidate evaluator, and request-local preparation tests all pass.
- Final-output selection and CLAMM ties, net redemption input to RFQ, suffix
  rounding/cap fallback, both venue fallback directions, aggregate error causes,
  two-second timeout cleanup, and freshness checks after slower reads.
- All twelve local receive-sizing directions, minimal input, bigint precision,
  unreachable targets, and exclusion of RFQ provider calls.
- Per-request account deduplication, overlapping pending reads, cached absence,
  fresh subsequent requests, existing batch budgets, one captured vault pricing
  timestamp, and no SDK account reads for aETH quotes.
- Byte/account boundaries with signature reservation, eligibility fallback and
  limit errors, both aETH validators, original server messages, execution-mode
  narrowing, quote IDs/minima, and unsupported cross-pair rejection.

Live coverage:

- All twelve core directions pass with the expected hop sequence. All eight
  BTC/USD swap-bearing cases explicitly receive and validate a fresh RFQ,
  including cases where CLAMM wins; silent RFQ failure cannot satisfy the suite.
  Both CLAMM and PropAMM win routes in this run.
- All thirteen successful quotes pass the 4,096-byte and 50-account-key checks.
  Serialized sizes, including all required signature slots, range from **610
  to 1,225 bytes**. aETH → aUSD preserves the original unsigned server message
  and passes at 696 bytes with two required signatures.
- aUSD → aETH rejects with `INVALID_RFQ`:
  `Unexpected RFQ fee payer or server signer.` A separate unsigned HTTP quote
  captured at `2026-11-03T00:32:22.574Z` is fresh at capture and has the correct
  dummy-user fee payer, but its treasury authority and mint program differ:

| Identity | SDK pin (unchanged from `fc6c4ef`) | Captured server response |
| --- | --- | --- |
| Treasury authority / second signer | `G31RGX9tmr7wE43aDPBHCLigAGn1EvvFQCvayZZm8kSK` | `GPoZuMS41Ct92nUUqWyu8dqCY74QkfHRX8N3RsYiTCAT` |
| Bridge program for treasury mint | `5n1fsUDhPiaALmxpaFCJeFdyTkZkxWXecgurV6dSxMq3` | `F5uRFVRuupfFgw1L5x7uWt41ug7MTZr2BfnfZiFj12fk` |

The baseline/current replay uses the same captured response and a fixed fresh
clock. Both reject at the existing signer check before transaction eligibility
or graph routing. This demonstrates that the observed incompatibility also
affects the pre-migration buy validator. Changing the graph cannot resolve it.
Registry pins, validators, fixtures, and failing live assertions remain intact.

Remaining external action: independently verify the intended aETH treasury/bridge
deployment, then align the RFQ server or the trusted SDK registry and native
fixtures in a separately reviewed change. Do not adopt identities solely from
an untrusted quote response. Rerun the buy case and the full fourteen-direction
live suite after deployment alignment. No decision about which deployment is
authoritative was made in this validation step.

The temporary artifacts also include `aeth-buy-request.json`, the unsigned
`aeth-buy-response.json`, decoded `aeth-buy-diagnostic.json`, the replay harness,
and combined `results.json`. Step 6 changes documentation only. No signing,
submission, deployment, publishing, or commits performed. Passing quote
construction and size checks does not establish funded execution or compute
provisioning; funded execution was not tested.

### Two-call account-loading follow-up (2026-11-03)

The user requested at most two account-reader calls per quote. This supersedes
Step 2's earlier three-call budget for RFQ-enabled routes with vaults.

- `prepareQuoteState` primes one request-local batch containing every known
  vault, pool, and mint account needed by the candidates. Vaults use their cached
  subset; CLAMM derives tick-array addresses from the cached pool and loads those
  arrays in the second batch. Deduplication and the initial vault-pricing
  timestamp are preserved; pricing, route selection, and transaction construction
  are unchanged.
- The loader validates account entries independently after checking response
  framing. A malformed optional CLAMM account cannot discard valid shared vault
  entries. Confirmed missing, malformed, or invalid shared accounts still fail
  without retrying them or invoking RFQ.
- If transport or response framing loses the entire first batch and an RFQ path
  requires vaults, the second call attempts only those vault accounts. CLAMM
  retains its original cached batch failure, so it cannot fetch ticks or trigger
  a third call, even if RFQ also fails. This is the only recovery read and the
  exception to fetching each address once: no successfully read address is
  fetched again. Vault-only and non-RFQ requests propagate batch errors directly.
- Direct BTC/USD RFQ requests can still start while the initial pool batch is
  pending; routes with a redemption start RFQ using its net output while tick
  reads are pending. RFQ calls retain their two-second timeout and no retries.
  aETH quotes remain separate and make no SDK account reads.

Current successful-loading budgets, with or without BTC/USD RFQ enabled:

| Route | Account-reader calls | Unique quote accounts |
| --- | --- | --- |
| Direct vault mint/redeem | 1 | 4 |
| Direct CLAMM/competing RFQ | 2 | Up to 6 |
| Vault plus asset swap | 2 | Up to 9 |
| Redeem, asset swap, mint | 2 | Up to 12 |
| aETH/aUSD direct RFQ | 0 | 0 |

One RFQ provider call is additional to these account-reader counts when enabled
for an exact-input swap. Mapping SDK batches to HTTP requests remains the
application's reader responsibility. Failure paths use at most two reader calls
as well; receive sizing remains local after those reads and never invokes RFQ.

Added 21 regressions: per-account failure isolation; transport/framing recovery
without a third call; malformed shared/optional responses; recovery followed by
RFQ rejection with original aggregate causes; redemption/RFQ/tick concurrency;
and all twelve receive-sizing paths with RFQ configured. Updated all eight
RFQ path assertions to require two reader calls, direct-vault assertions to
require one, and preparation tests for nine-account initial batching and cached
tick reads. The existing direct-pool/RFQ concurrency test now exercises the
public client while the initial pool batch is pending.

| Command | Result |
| --- | --- |
| `corepack pnpm typecheck` | Passed, including public consumer contracts. |
| `env -u ARCH_RPC_URL -u ARCH_RFQ_URL corepack pnpm test --reporter=default --reporter=json --outputFile=/tmp/arch-router-two-call/offline.json` | Passed: **846 tests across 20 files**; 14 live tests skipped. |
| `corepack pnpm build` | Passed. |
| `node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --resolveJsonModule tests/quote-state.test.ts tests/quote-candidates.test.ts tests/utils.test.ts` | Passed: additional strict checking of the changed loader, preparation, and evaluator tests. |
| `git diff --check` | Passed. |

Logs and the offline JSON report are in `/tmp/arch-router-two-call/`. The prior
13/14 live result and aETH buy deployment mismatch remain recorded above; live
tests were not rerun for this follow-up. No public interfaces, deployment pins,
RFQ terms, native fixtures, or dependencies changed. No signing, submission,
deployment, publishing, or commits performed.
