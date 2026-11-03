# Tests

## Live quote smoke test

`quote.e2e.test.ts` contains 16 live quote cases: the original 14 directions
among aBTC, aUSD, primeBTC, primeUSD and aETH, plus two opted-in composable
aETH sell cases (aUSD and primeUSD output):

| Route type | Pairs, each tested in both directions |
| --- | --- |
| Asset swap | aBTC ↔ aUSD |
| Direct server RFQ | aETH ↔ aUSD |
| Direct vault mint/redeem | aBTC ↔ primeBTC; aUSD ↔ primeUSD |
| Vault plus swap | primeBTC ↔ aUSD; primeUSD ↔ aBTC |
| Redeem, swap, mint | primeBTC ↔ primeUSD |
| Composable aETH sell | aETH → aUSD; aETH → primeUSD |

Inputs are 1 aUSD/primeUSD, 0.00001 aBTC/primeBTC, or 0.001 aETH. aETH uses
9 decimals; aUSD uses 6. Each test checks an explicit expected token path and
operation sequence and positive estimated/minimum output. Router quotes must
contain instructions, every hop must consume the preceding hop's estimated
output, and the final hop must match the overall estimate.

Router instruction bundles are compiled with a zero blockhash for size
measurement. ETH/USD quotes retain the original server transaction and are
measured without recompilation. All routes are checked against the dependency's
**4,096-byte** and **50-account-key** limits, including program keys and one
64-byte signature for CLAMM/vault-only routes or both signatures for PropAMM/direct
RFQ. Placeholder signatures are used only
for size measurement; the tests do not sign or submit transactions.

BTC/USD swap legs also request PropAMM quotes from
`https://vaults.veloxapi.net/propamm/rfq/quote`, using the test-only HTTP adapter
in `helpers/propamm-rfq.ts`. The SDK compares CLAMM and PropAMM by final output;
CLAMM wins ties. The tests require exactly one fresh RFQ for the swap leg using
its actual asset mints and net input after any vault redemption. Direct vault
mint/redeem routes must make no RFQ requests. A selected PropAMM hop must match
the received RFQ's quote ID and estimate. For routes ending in a swap, the final
estimate must be at least the RFQ estimate. A vault suffix changes output units
from assets to shares, so these raw amounts are not compared across that suffix.

ETH/USD routes use the separate `directRfqQuoteProvider` and the HTTP decoder
exported as `createAethUsdRfqProvider` by `examples/aeth-usd.ts`, at the same RFQ
endpoint. The tests request 1 aUSD → aETH and 0.001 aETH → aUSD with 100 BPS
slippage. They require one HTTP quote call, no account reads or BTC/USD RFQ calls,
an unsigned `serverTransaction` result, the original message bytes and quote ID,
and a fresh deadline. Buys must use `treasuryMint`; sells must use `propamm`.

It uses a dummy public key and only reads state; no wallet, funded balance,
signing or transaction submission is needed.
The reader normalizes JSON byte arrays and supplies an empty legacy `utxo`
field when the RPC omits it; quote calculation does not use that field.

Each test prints the selected route from `quote.hops`, a table of each hop's raw
input/output, the final estimate, and the serialized transaction size with its
signature count. BTC/USD swap routes also print the PropAMM RFQ estimate.
Depending on prices, the routes can differ by direction, for example:

```text
Route: aUSD --[propamm]--> aBTC
Route: aBTC --[clamm]--> aUSD
Route: aBTC --[vaultMint]--> primeBTC
Route: primeUSD --[vaultRedeem]--> aUSD --[propamm]--> aBTC --[vaultMint]--> primeBTC
Route: aUSD --[treasuryMint]--> aETH
Route: aETH --[propamm]--> aUSD
```

All live tests are skipped unless `ARCH_RPC_URL` is set. Run them with a mainnet RPC:

```sh
ARCH_RPC_URL=https://rpc.mainnet.arch.network \
  corepack pnpm exec vitest run tests/quote.e2e.test.ts
```

Append `-t aETH` to run all four ETH cases.
Use `-t 'composable aETH'` to run only the two composable sell cases. These
require zero/one account-reader calls, respectively, one fresh native aETH sell
RFQ, preserved terms/quote ID and original response, router instruction bundles,
final-only slippage, and both transaction limits. `-t aETH` also includes these
two cases in addition to the original direct ETH directions.

The RPC endpoint must match the client's `mainnet` network. Set `ARCH_RFQ_URL`
to override the default RFQ base URL (including `/rfq`, without `/quote`). The
HTTP adapter preserves native u64 terms, rejects unsafe numeric JSON output
metadata, and validates the returned trade's program, config, user, mints and
encoded input. It aborts HTTP requests after 1.8 seconds, within the SDK's
2-second RFQ budget, without retries.

Output depends on live liquidity, so the tests check positive amounts rather
than a fixed price. RFQ HTTP/decoding/expiry failures fail the smoke tests even
when the SDK falls back to CLAMM; they cannot silently pass without RFQ coverage.
This includes ETH/USD `quote_not_executable` inventory errors; neither direction
is skipped or marked as an expected failure when its provider is unavailable.
RPC, deployment and liquidity failures also fail the tests. Vault mint quotes
can reject stale NAV, paused vaults or deposit caps; immediate redeem quotes
can reject a nonempty queue or insufficient reserves. These failures remain
visible rather than being skipped. This verifies live quote generation and
instruction construction. Funded signing, submission and confirmation tests
are still needed to establish transaction execution.

The final routing validation on **2026-11-03** passed typecheck, build, and all
**825 offline tests** (14 live cases skipped for that offline run). The separate
network-enabled live suite passed **13/14**, with no skips: all twelve core
directions and aETH → aUSD. aUSD → aETH failed with `INVALID_RFQ` because the
server's treasury signer and bridge program differ from the pinned registry.
Replaying a captured response through the baseline and current buy validators
produces the same rejection. The test remains a failure; pins and validators
were not relaxed. See the
[Step 6 results](../DYNAMIC_ROUTING_IMPLEMENTATION_PLAN.md#step-6-results-2026-11-03)
for commands, response identities, and the remaining deployment alignment.

The subsequent two-call batching follow-up passes typecheck, build, and **846
offline tests**, including account-read limits and failure recovery. Its 14 live
cases were skipped; the earlier live results above have not been rerun against
that follow-up.

`propamm-rfq-provider.test.ts` checks the HTTP adapter offline against the pinned
native Buy/Sell trade bytes. It covers both payload lengths, account-index
resolution, adjusted estimates, full-u64 precision, substituted identities,
malformed payloads and HTTP errors without retries.

## aETH/aUSD direct RFQ coverage

`composable-aeth.test.ts` adds 36 offline cases for the explicit sell opt-in,
market-specific edges/providers, shared-config edge identities, server capability
filtering, deduplicated 15-pair metadata, and unchanged direct buys/defaults.
It reuses the independent native aETH sell transaction and Rust vault-layout
fixtures to verify original compact terms, native vault/nonce identities,
the router's read-only maker signer, suffix fees and final slippage, u64 input
precision, byte/account limits, expiry/timeout handling, malformed quotes,
request snapshotting, actionable vault errors and no direct fallback. aUSD
outputs read no accounts; primeUSD outputs use one four-account batch with
no pool/tick reads. Unsupported BTC/reverse/receive paths reject before I/O.
Public consumer type tests cover the optional boolean flag.

The temporary native audit described in the plan also passes the SDK's two
unsigned router messages through the unmodified Rust server validator. That
validates its quote/account contract; it does not co-sign, submit or execute.
The final sell follow-up passes typecheck, build, and **882 offline tests**
(16 live cases skipped). The targeted live composable sell run also passes both
cases: zero/one reader calls and 756/989 bytes with required signatures reserved.
The other 14 live cases were filtered out, not rerun. Reports and the native
validator replay are recorded in the plan's composable-sell follow-up.

`config/aeth-usd.test.ts` replays unsigned buy/sell fixtures generated by the
pinned Rust `minting` builders. It checks programs, account order, PDA/ATA
derivations, output-account creation layouts, signer roles, raw amounts with
9 aETH decimals and 6 aUSD decimals, blockhash and native serialized sizes
(738/696 bytes with both signatures).
See [fixture provenance](fixtures/aeth-usd/README.md).

`direct-rfq.test.ts` and `direct-rfq-sell.test.ts` validate the two native
templates. They reject substituted accounts/programs/signers/recipients, wrong
input or output, account privileges, malformed framing, missing creation
accounts, extra instructions, unsafe numeric metadata and expired deadlines.
They also verify u64 precision, expiry clamping, signed minima and the 4,096-byte
limit with both eventual signatures reserved. Both normalizers also reject a
51-key original message below the byte limit and preserve the server transaction
when rejecting it.

`transactions/size.test.ts` checks the dependency-supplied byte/account limits,
the size guard at 4,096 and 4,097 bytes with one and two signatures, automatic
reservation of missing signature slots, and 50/51-key boundaries below the byte
limit. Canonical compilation tests distinguish repeated instruction positions
from unique message keys and count the program key. Measurement leaves unsigned
messages and their signature arrays unchanged.
PropAMM coverage retains the native fixture byte
comparisons and verifies that a 1,257-byte bundle with distinct fee destinations
is now eligible under the higher limit.

`direct-rfq-client.test.ts` covers opt-in mainnet metadata and public dispatch,
both original server transactions, alternate valid account ordering/blockhashes,
earlier client deadlines (one millisecond before and exactly at expiry), invalid
responses, provider errors, timeout cleanup and absence of retries/fallback or
account reads. Unsupported ETH combinations and receive sizing reject; clients
without the provider and testnet clients retain their existing routes.
`types/direct-rfq.ts` checks the public provider contract and quote-result
narrowing with positive and negative consumer type assertions.

These tests validate message layouts offline. Missing-output-account creation,
funded balances and execution against deployed programs still need runtime smoke
coverage. `examples/aeth-usd.test.ts` runs the working example through mocked HTTP,
wallet signing, submission and confirmation in both directions. It checks original
message preservation, full-u64 input JSON encoding, safe metadata decoding,
malformed bytes, deadline checks around the wallet, unchanged retry payloads,
known-hash confirmation retries, concurrency and failure propagation. It does not
execute deployed programs or simulate their account-creation CPIs.

## Existing router coverage

`client.test.ts` verifies request validation and unsupported/identical pairs,
all before reads. It also covers default/explicit testnet metadata, immutable
selection, unknown networks, valid mainnet-v2 deployments, and both mainnet quote
methods using their own reader and propagating failures.
`config/mainnet.test.ts` checks public RPC snapshots for actual mint decimals,
CLAMM order, vault relationships and the config shared by the BTC/ETH markets.
`config/routes.test.ts` checks all 12 directed pairs against
native fixture paths, operation/venue order, route continuity, unique mints,
one-to-three-hop lengths, and immutable public pair metadata.
It verifies that the same paths use each deployment's venue endpoints and mint
addresses. Graph tests also cover optional parallel CLAMM/PropAMM candidates,
provider/deployment gating, receive-sizing RFQ exclusion, cycles and self loops,
missing paths, the three-hop and one-RFQ bounds, deterministic discovery, frozen
pair/candidate metadata, and construction without account or provider calls.
Synthetic graphs exercise hop/RFQ limits beyond the current deployment topology.

`utils.test.ts` checks shared address helpers and SDK-delegated ATA and
vault/reserve/escrow derivation against Rust account-validation fixtures. Integer
range and account-meta helpers remain covered through codec and builder tests.
It also covers ordered/deduplicated batches, null preservation, malformed
responses, and APL decoding bounds and initialization/option tags.
Request-local loader tests cover overlapping in-flight batches, cached absence
and failures without retries, empty loads, and fresh reads in the next request.
They also verify that a malformed account response does not discard valid
accounts from the same batch.
Receive-sizing tests bound local work, preserve u64 precision, and reject
unreachable targets or unrelated calculation errors.

`quote-state.test.ts` checks that preparation fetches only the requested venues,
shares decoded vault state between graph candidates, refreshes mutable mint
supply on later requests, and shares concurrent CLAMM preparation and its reads.
Known vault/pool/mint accounts share one initial batch, followed by at most one
tick-array batch. If transport or framing loses the entire initial batch while
RFQ is enabled, only required vaults are recovered in the second call; the
original CLAMM failure remains cached and cannot trigger a third call.
Confirmed invalid shared accounts still fail immediately. One vault-pricing
timestamp is captured before asynchronous reads. `propamm.test.ts`
also verifies that destination-vault caps can reject the larger swap estimate
while retaining the smaller CLAMM or PropAMM candidate, and that common vault
prefix failures prevent RFQ calls. All eight RFQ swap paths require two reader
calls on successful loading, and all twelve receive-sizing paths retain the
one-/two-call budget even with an RFQ provider configured. Failure tests cover
per-account isolation, bounded vault recovery, original aggregate error causes,
and RFQ concurrency with pending pool/tick reads.

`quote-candidates.test.ts` checks the common graph evaluator's venue concurrency,
CLAMM's preference on equal final output even with reversed candidate order,
stable minimum-input receive sizing, provider exclusion from receive sizing,
original aggregate failure causes, sole-candidate errors, and request-field
stability across asynchronous account preparation. Synthetic local paths verify
that receive sizing minimizes input even when another path has more output
overshoot. `propamm.test.ts` retains coverage of final suffix rounding, native
RFQ terms, prefix inputs, two-second timeout cleanup, and RFQ expiry after slower
CLAMM reads, including the aggregate expiry cause when both venues are unusable.
Eligibility tests inject synthetic compiled messages at the shared guard boundary
to exercise 4,096/4,097 bytes and 50/51 accounts for both preferred venues. They
verify acceptance at each limit, fallback when either larger candidate exceeds
it, original limit causes when all candidates fail, and sole-candidate errors
for exact-input/receive-sized CLAMM and vault-only public quotes. Each bundle is
checked once with its real header and zero measurement blockhash; current native
fixtures fit both limits and retain their original returned instruction layouts.

`vault.test.ts` covers the native account layout, 12 Rust math vectors, fees,
virtual offsets, caps, Mint NAV boundaries, immediate-redemption eligibility,
and overflow. All four direct public quote paths match existing Rust account
lists and encode the quoted amounts, final minimum and exact deadline. Tests
verify one four-account batch, fresh subsequent reads, changed fee recipients
and queue tails, missing state, wrong owners/relationships, and transport errors.
Alternate deployment coverage verifies selected vault/mint identities, owners,
reserve/escrow/entry/event PDAs, and fee ATAs.
See [vault provenance and native behavior corrections](fixtures/vault/README.md).

`clamm.test.ts` checks native serialized pool/tick layouts, 11 native tick prices,
and 21 native swap cases. It covers both directions, negative ticks, fees and
rounding, signed liquidity crossings, empty liquidity gaps, width overflow,
three-array windows, boundary repetition and minimum-price recovery. Public
quotes cover initialized/absent arrays, malformed state and transport failures,
insufficient windows, fresh subsequent reads, and intermediate-hop failures.
All 12 core directions match independently composed Rust outputs and existing
Rust instruction account lists; encoded input/minimum/deadline and window
limits are verified. Direct vault quotes read once; CLAMM routes share two
batches total, with no repeated keys or construction reads. See
[CLAMM provenance and regeneration](fixtures/clamm/README.md).
Network coverage checks default/explicit testnet quote parity while a mainnet
client coexists, plus alternate CLAMM pool/mint identities, account owners,
tick/oracle PDAs and tick-to-pool validation through both loading stages.

`quoteForOutput` is tested against all 12 native composed outputs. Each result
matches a forward quote at the calculated input, while one raw input unit less
falls short. Tests retain the one-/two-batch budget and cover fixed fees, vault
caps and redemption coverage, unavailable state, tick crossings, u64-scale
inputs, rounding overshoot, final slippage, and fresh reads on subsequent calls.

`codecs/instruction.test.ts` and `codecs/result.test.ts` cover wire framing,
integer widths/ranges, step counts, both CLAMM directions, result lengths and
versions, and byte views. The strict result decoder stays internal; transaction
status and confirmation are application responsibilities. See
[codec fixture provenance](fixtures/router-codec/README.md).

`transactions/instructions.test.ts` compares the single returned router
instruction with its counterpart in all 18 original Rust fixtures. It preserves
byte/account/privilege coverage, including duplicate fee/tick positions and
native supplemental-array encoding. The fixture's leading input-ATA instruction
is deliberately not returned. The router's ATA/system trailer is retained and
construction performs no network reads.
An alternate-program test verifies the selected router and CPI programs, user
ATAs, and ATA/system trailer while preserving the native account order and bytes.

Standalone router-instruction construction stays independent of transaction
policy. Public quotes enforce byte/account limits on the actual returned bundle
before selection. Original fixture JSON, generators, and provenance remain
intact; recorded historical full-bundle sizes include the fixture's input ATA.
See [transaction fixture provenance](fixtures/transactions/README.md).

The Step 5 compatibility audit unpacks the built private package into a temporary
consumer and resolves only its declared runtime dependencies. It checks the
seven runtime exports, blocked private subpaths, packed consumer declarations,
and the existing public type-narrowing contracts. It then runs the same 34 quote
flows in Node and an ES2022 browser-targeted bundle in an isolated V8 context
without `process`, `Buffer`, or `require`: twelve core exact-input routes,
twelve receive-sizing routes, eight router RFQ routes, and both mainnet aETH
directions. Both environments also exercise eight provider/network combinations
and 24 early-validation cases, with no transport calls. Node/browser results
match, including complete signed-size estimates and compiled account counts.
See the dynamic routing plan's Step 5 log for commands and temporary artifacts.

This audit does not launch an actual browser or consumer frontend. Step 6 covers
final offline validation and live quote-only construction. No current fixture
proves live executability or adequate compute provisioning.
