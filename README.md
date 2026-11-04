# Arch swap router TypeScript SDK

A compact, browser-oriented SDK for configured-pair swap estimates and router
instructions on Arch. Testnet and mainnet-v2 swaps, vaults and prime tokens
are configured.
One quote call returns one estimate with its
instructions, sized from either a fixed input or an approximate receive amount.
Supported pairs use graph-generated one-to-three-hop paths
through the two vaults and the aBTC/aUSD CLAMM, with optional PropAMM RFQs for
exact-input swaps on either network. A mainnet direct RFQ provider and an
explicit market catalog enable additional inventory and treasury quotes.

All 12 core directions support exact-input quotes and receive sizing. Unsupported
or identical mint pairs reject with `UNSUPPORTED_PAIR` before account or provider calls.

**Latest offline validation (2026-11-03):** typecheck, build, and 882 tests pass,
including composable aETH sells and the two-call account-loading budget. Both
new composable sell cases also pass live, using zero/one reader calls and
756/989 bytes with signatures reserved. Earlier live quote-only tests
passed 13/14 directions, before the batching follow-up: all twelve core pairs and
aETH → aUSD. aUSD → aETH rejects because the server's treasury authority and
bridge program differ from the SDK's pinned deployment. The existing validator
also rejects that response; deployment alignment remains outstanding.

Current routing scope, progress, and validation are recorded in
[DYNAMIC_ROUTING_IMPLEMENTATION_PLAN.md](DYNAMIC_ROUTING_IMPLEMENTATION_PLAN.md).
[SIMPLIFICATION_PLAN.md](SIMPLIFICATION_PLAN.md),
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), [HANDOVER.md](HANDOVER.md), and
[PROPAMM_ROUTER_SDK_HANDOVER.md](PROPAMM_ROUTER_SDK_HANDOVER.md) describe earlier
implementation stages; current source and the dynamic routing plan govern this
migration.
Path discovery and quote evaluation now use graph candidates with shared state
within each request. Exact-input quotes select the highest final estimated
output, with CLAMM winning ties; receive sizing selects the smallest valid input
using only local vault/CLAMM estimates. Every returned bundle fits the dependency's
transaction byte and account limits.
The internal graph uses the selected registry, simple paths of at most three
hops, and at most one PropAMM step. Core markets come from the network registry. Configured RFQ markets use
validated native quote terms in composed router instructions.

## Frontend API

```ts
import {
  createRouterClient,
  type RouterDataSource,
} from "@arch-network/swap-router-sdk";

// The application supplies a normalized, batched reader for the selected network.
declare const source: RouterDataSource;
declare const walletAddress: string;

const router = createRouterClient({ network: "testnet", source });
const mints = router.mints;
if (!mints) throw new Error("Selected network is not configured");

// router.supportedPairs lists this network's supported input/output combinations.
const swap = await router.quoteExactIn({
  inputMint: mints.aUSD,
  outputMint: mints.primeUSD,
  amountIn: 1_000_000n,
  slippageBps: 50,
  user: walletAddress,
  deadlineMs: Date.now() + 120_000,
});

// Receive-side entry: calculate the fixed input for a desired output estimate.
const receive = await router.quoteForOutput({
  inputMint: mints.aBTC,
  outputMint: mints.aUSD,
  amountOut: 100_000_000n, // Desired output in raw units, before slippage.
  slippageBps: 50,
  user: walletAddress,
  deadlineMs: Date.now() + 120_000,
});
```

`network` accepts `"testnet" | "mainnet"` and defaults to `"testnet"`. Each
client keeps its selected deployment; create a new client with the matching
reader when switching networks. The SDK does not choose RPC/indexer endpoints.
Use readonly `router.network`, `router.mints`, and `router.supportedPairs` for
frontend metadata. Existing `TESTNET_MINTS` and `SUPPORTED_PAIRS` exports remain
testnet-only aliases.
Pair metadata is frozen and derived from bounded graph reachability. It describes
configured capabilities; a quote still depends on valid state and liquidity.
Match pairs by their mint addresses; list order follows deterministic graph node
order and is not an application identifier.

Mainnet's router, CLAMM pool/program, PropAMM deployment and aBTC/aUSD mints are
configured in [src/config/networks.ts](src/config/networks.ts). Its CLAMM pool
orders aBTC as token A and aUSD as token B. Its vaults and prime-token mints
match the mainnet-v2 deployment. The BTC RFQ and aETH market use the same
PropAMM program and config. The client exposes all 12 core pairs, plus the two
optional mainnet direct RFQ directions when a provider and catalog are configured.
Supply a reader and optional RFQ providers for the selected
network; there is no testnet fallback.
Account validation, PDA/ATA derivation and instructions use the selected deployment.

`SwapQuote` is a union of `RouterSwapQuote` and `ServerTransactionSwapQuote`.
Both contain `inputMint`, `outputMint`, `amountIn`, `estimatedAmountOut`,
`minAmountOut`, `hops`, and `deadlineMs`. Amounts use raw `bigint` units and
addresses use base58 strings.

- `RouterSwapQuote` contains `instructions` and optional `rfq: { quoteId }` when
  PropAMM wins. Existing quote objects omit `execution`; its optional value is `"router"`.
- `ServerTransactionSwapQuote` has `execution: "serverTransaction"`, the original
  unsigned `transaction`, and required `rfq: { quoteId }`. It has no `instructions`.

Check `quote.execution === "serverTransaction"` before accessing router
instructions. See [Direct RFQ transaction contracts](#direct-rfq-transaction-contracts)
for the direct provider contract and submission behavior.

`hops` is an ordered `SwapHop[]` for the selected route. Each hop contains `kind`
(`vaultMint`, `vaultRedeem`, `clamm`, `propamm`, or `treasuryMint`), `inputMint`, `outputMint`,
`amountIn`, and `estimatedAmountOut`. Only the first input is fixed; later inputs
are the preceding hop's estimated output. The last hop's output matches the
overall estimate, with slippage applied only to the final `minAmountOut`.
Both quote methods include hops without extra account or RFQ requests.

`quoteForOutput` finds the smallest valid input whose estimated output reaches
`amountOut`. Integer rounding can make the estimate larger than the requested
amount. It returns a `RouterSwapQuote`, with the calculated fixed `amountIn`;
slippage is applied once to `estimatedAmountOut`. For an estimate of 100 tokens
and 50 BPS slippage, the minimum is 99.5 tokens, subject to raw-unit rounding.
This is approximate receive sizing: execution spends the fixed input and may
receive less than the target within slippage. It is not exact-output execution
with a maximum-input allowance.

Both methods support all 12 existing pairs. The two optional ETH/USD directions
support `quoteExactIn` only. Receive sizing reuses the fetched, decoded
state for a bounded local search; the read counts below are unchanged. Targets
outside the vault/CLAMM limits reject instead of returning a partial quote.

The reader returns ordered `AccountInfoResult | null` values with `owner` and
`data` normalized to `Uint8Array`; malformed responses and transport failures
reject. Each quote reads fresh state, and building adds no fetches. One SDK batch
is one HTTP request only if the application's reader/provider supports it.

| Route | First batch | Second batch | Reader calls |
| --- | --- | --- | --- |
| Direct vault Mint/Redeem | 4 accounts | None | 1 |
| Direct CLAMM | 3 accounts | Up to 3 tick arrays | 2 |
| Vault + CLAMM, either order | 6 accounts | Up to 3 tick arrays | 2 |
| Redeem + CLAMM + Mint | 9 accounts | Up to 3 tick arrays | 2 |

These budgets apply with or without an RFQ provider and to every
`quoteForOutput` call. All SDK quotes use at most two account-reader calls;
failures can stop loading earlier. The first batch contains every known vault,
pool, and mint account; the second contains the derived CLAMM tick arrays.
With PropAMM enabled, a swap quote also makes one RFQ provider call. aETH quotes
on the default direct path make no SDK account reads. Composable aETH sells
make zero account reads for aUSD output or one four-account USD-vault batch for
primeUSD output. Both use one direct RFQ provider call.
Overlapping account requests share pending reads and confirmed absence within a
quote. Decoded venue state is reused for that quote; subsequent quotes fetch
fresh state. Each successfully read account is fetched only once. Malformed
individual responses and CLAMM validation errors remain isolated to candidates
that need those accounts; amount-dependent vault checks run per candidate too.
If competing RFQ/CLAMM paths' entire first batch fails transport or response framing,
the second call recovers only its required vault accounts. CLAMM retains the
original batch error, so no tick reads or third call follow. This recovery can
request vault addresses again after a failed batch; confirmed missing or invalid
shared accounts fail without recovery. RFQ calls are never retried.

Only confirmed account absence should return `null`; resolve indexer cache misses
in the application reader. CLAMM treats absent or empty system-owned tick accounts
as uninitialized arrays, matching the native program.

Mint checks pause, NAV freshness, fees and the full-deposit cap. Redeem requires
an empty observed queue and enough reserve for the gross claim. Both use the
observed share supply; management fees accrue in native `Report`. Estimates use
raw units, native rounding and one final slippage floor. State can change before
execution; quotes describe observed state and execution depends on the deployed
programs and current liquidity.

CLAMM estimates stay within three primary tick arrays, with zero supplements
and an explicit window price limit. Quotes reject if that window cannot consume
the full input. Each hop receives the preceding estimated output; slippage is
applied only to the final result.

CLAMM/vault quotes return just the router instruction, whose ATA/system trailer
enables missing user ATA creation. PropAMM quotes use the native tested layout:
an idempotent input-ATA instruction followed by the router. This supplies the
two-instruction compute allowance needed by the tested three-hop execution.
Do not replace it with a compute-budget instruction; the signing server accepts
only the canonical input-ATA/router bundle.

For instruction-based router quotes, the application owns quote refresh, final
transaction compilation, blockhashes, signing, submission, deadline handling,
and confirmation. The SDK provides estimates, instruction encoding, and
transaction byte/account eligibility checks.

The runtime transaction limit is **4,096 bytes**, exported as
`TRANSACTION_SIZE_LIMIT`, an alias of arch-sdk's `RUNTIME_TX_SIZE_LIMIT`.
The account limit is **50 compiled unique keys**, including program keys, from
arch-sdk's `MAX_ACCOUNTS_PER_TRANSACTION`. The SDK measures the complete returned
bundle with every required 64-byte signature slot reserved. Router bundles use a
32-byte placeholder blockhash; aETH uses its original server message. These checks
make no account or blockhash RPC calls and follow both dependency constants.
An over-limit candidate is excluded before quote selection, leaving an eligible
alternative available. A sole candidate exposes `TRANSACTION_TOO_LARGE` or
`TRANSACTION_TOO_MANY_ACCOUNTS`; exhausted competing candidates expose `NO_ROUTE`
with the underlying errors in its `AggregateError` cause.
If the application appends instructions to a router quote, recompile and recheck
the final key count and `TransactionUtil.serializedSize`, reserving all required
signature slots. The live quote smoke test checks both limits for every route.

## Optional PropAMM quotes

Inject an application-owned provider returning `PropAmmQuote`: a nonempty
`quoteId`, Base58 `quoteSigner`, original `terms` (`side`, `baseAmount`, `quoteAmount`, `expiryMs`,
`nonce`), and `estimatedAmountOut` after inventory skew. All amounts, expiry and
nonce are `bigint`; side is `"buy" | "sell"`. The provider receives the swap-leg
`inputMint`, `outputMint`, `amountIn`, and `user`, including net redemption output
when a vault precedes the swap.

```ts
import {
  createRouterClient, compileRouterMessage,
  type PropAmmQuoteProvider, type QuoteExactInRequest, type RouterDataSource,
} from "@arch-network/swap-router-sdk";

declare const source: RouterDataSource;
declare const propAmmQuoteProvider: PropAmmQuoteProvider;
declare const request: QuoteExactInRequest;
declare const recentBlockhash: Uint8Array; // Fetched by the application.

const router = createRouterClient({ source, propAmmQuoteProvider });
const quote = await router.quoteExactIn(request);
if (quote.execution === "serverTransaction") {
  // Sign quote.transaction.message unchanged and submit under quote.rfq.quoteId.
} else {
  const message = compileRouterMessage(quote.instructions, request.user, recentBlockhash);
  // Sign this message with the user's wallet. quote.rfq selects RFQ server submission.
}
```

`quoteExactIn` compares at most two graph candidates for the requested pair.
Higher final output, including vault fees and rounding, wins; CLAMM wins ties.
Each RFQ waits at most **2 seconds**, without retries. A declined, invalid,
expired RFQ or one exceeding either transaction limit leaves CLAMM available;
a CLAMM-specific failure leaves PropAMM available. Required shared-vault failures
invalidate both. A destination vault's amount-dependent failure rejects only the
candidate whose output violates its constraints. Direct vault quotes and
`quoteForOutput` never call the provider.

The PropAMM deadline is `min(request.deadlineMs, terms.expiryMs)`, rechecked at
selection. Original compact terms are preserved. The SDK checks the compiled
PropAMM bundle against 4,096 bytes and 50 compiled account keys. Byte measurement
reserves both 64-byte signatures; callers must recheck if they alter the bundle.
The native three-hop fixture is 1,225 bytes with shared fee destinations;
distinct fee accounts increase its serialized size.

The application provider maps requests to `POST /rfq/quote`: deployment aBTC
`base_mint` and aUSD `quote_mint` in hex, `side` (`sell` for aBTC → aUSD, `buy`
for the reverse), raw input `amount`, and hex `user_pubkey`. Verify the returned
native instruction's program, config, user and mint identities against the request and
deployment. Resolve its quote-signer account (instruction account position 1)
through the message account-key indices and return it as `quoteSigner`. The
router checks this signer against the live on-chain config; do not cache a signer
globally or replace the signer in a previously built quote.
Decode its original compact terms with `DataView.getBigUint64`, and
use `estimated_quote.base_amount` for Buy or `estimated_quote.quote_amount` for
Sell as the adjusted output. The HTTP API uses numeric JSON u64s: use lossless
decoding or reject unsafe values; ordinary `response.json()` and arbitrary
`bigint` → `number` casts can lose precision. Transport/proxy setup stays in the
application; the SDK never calls the server directly.

PropAMM uses the network's configured config account and config-owned vaults.
Vault seeds are `["vault", config, mint]`; config and nonce addresses stay fixed
during subsequent signer rotations. Only `quoteSigner` changes between quotes,
so rotation needs no SDK release or additional RPC read. The SDK resolves these
accounts from the registry and RFQ; it does not fetch or upgrade the config.
The [recorded mainnet snapshot](tests/fixtures/mainnet-v2/README.md) was v3 when
captured. Router source support for v2/v3/v4 does not establish the current live
storage version or deployment readiness.

For a router RFQ winner, compile with **`compileRouterMessage`**, which corrects
arch-sdk 0.13.0's insertion ordering to the Rust account ordering required by the
signing server. Sign the resulting router message with the user, then send
`POST /rfq/swap` with `{ quote_id: quote.rfq.quoteId, version: 0,
signatures: [userSignature], message }` in the server's JSON transaction format
(Arch SDK's `TransactionUtil.toNumberArray` provides that representation).
The server validates it, adds the read-only maker's signature and broadcasts,
returning `{ transaction_hash }`. Do not reuse the standalone RFQ message.
Once submission binds the quote, retries must use the identical message; a new
blockhash or route requires a fresh quote. The SDK does not sign or submit.

After redemption, PropAMM accepts measured input only within
`ceil(quotedInput * (10000 - max_input_shortfall_bps) / 10000) .. quotedInput`.
PropAMM v4 stores the tolerance in its config; v2/v3 default to 50 bps.
The on-chain router must support the config's storage version. Execution outside that range
fails atomically; the SDK does not pad/cap the input or consume existing
intermediate balances. There is no post-signing venue fallback.

This integration is verified offline. Live use requires compatible
router and RFQ signing-server deployments; source availability does not confirm
deployment.

## Development

Use Node 20.19+ in the 20.x line or Node 22.12+. Dependencies remain pinned to
`@arch-network/arch-sdk@0.13.0` and `@scure/base@1.2.6`, with pnpm 10.12.4.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

Tests verify all 12 quote paths against native Rust math, shared read budgets,
native instruction bytes, account positions/privileges, PDA/ATA derivation, and
result framing. PropAMM tests additionally compare all eight complete signed
Rust transaction fixtures, signer permissions and compiled size, plus candidate
selection and failure isolation. Fixtures retain their original Rust provenance;
tests do not establish live compatibility.

The packed SDK's public entry point has been checked in Node and an ES2022
browser-targeted bundle running in an isolated V8 context without Node globals.
Both runs cover all 12 core exact-input paths, all 12 receive-sizing paths, eight
router RFQ paths, and both aETH server-transaction directions using offline
fixtures. Consumer type checks cover the packed declarations and private graph
boundary. This is package/runtime compatibility coverage; actual-browser app
integration and live quote generation are separate checks.
The package stays private and exports only its root entry point. Wallet signing
and transport remain application-owned, and graph construction/evaluation stay
internal to the SDK. Step 6 in the dynamic routing plan records final offline
validation and live quote-only results; its two-call follow-up log records the
latest loading changes and offline checks.

## Configure direct RFQ markets

Set `directRfqDeployment` once for the maker's program, config and quote
signer. Add the treasury authority and bridge program there if the provider can
return treasury-mint quotes. Each market lists only its mints and supported
sides. Token programs come from the selected network, and the router derives
market vaults from the config and mints.

For example, opt in to the existing aETH market on mainnet:

```ts
import {
  createRouterClient, MAINNET_AETH_USD, MAINNET_RFQ_DEPLOYMENT,
  type DirectRfqQuoteProvider, type RouterDataSource,
} from "@arch-network/swap-router-sdk";

declare const source: RouterDataSource;
declare const directRfqQuoteProvider: DirectRfqQuoteProvider;

const router = createRouterClient({
  network: "mainnet",
  source,
  directRfqQuoteProvider,
  directRfqDeployment: MAINNET_RFQ_DEPLOYMENT,
  directRfqMarkets: [{
    baseMint: MAINNET_AETH_USD.baseMint,
    quoteMint: MAINNET_AETH_USD.quoteMint,
    sides: ["buy", "sell"],
  }],
});
```

Use the host application's mint registry to add other entries. An omitted or
empty catalog enables no direct RFQ markets. The provider returns the original
unsigned packet, quote ID, expiry and estimated output. The router validates
the packet against the deployment, then uses its terms to build the route.
Treasury identities are needed only when the packet uses treasury minting.
Direct RFQ edges support exact input on mainnet.

Compile the returned instructions with a fresh blockhash and submit the
user-signed transaction with its quote ID for maker co-signing. See the
[working example](examples/README.md).
