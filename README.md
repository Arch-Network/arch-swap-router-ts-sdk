# Arch swap router TypeScript SDK

A compact, browser-oriented SDK for configured-pair swap estimates and router
instructions on Arch. Testnet and mainnet-v2 swaps, vaults and prime tokens
are configured.
One quote call returns one estimate with its
instructions, sized from either a fixed input or an approximate receive amount.
Supported pairs use graph-generated one-to-three-hop paths
through the two vaults and the aBTC/aUSD CLAMM, with optional PropAMM RFQs for
exact-input swaps on either network. An optional mainnet direct RFQ provider adds
aETH and aHYPE exact-input buys and sells against aUSD, primeUSD, aBTC and primeBTC.
All client quotes return router instructions. A validated buy packet resolves
into a native swap or a terminal treasury mint according to the server response.

**Current status:** all 12 core directions support exact-input quotes and receive
sizing. A configured mainnet direct RFQ provider enables eight directions for each asset,
for 28 unique pairs overall. Unsupported or identical mint pairs reject with `UNSUPPORTED_PAIR`
before account or provider calls.
Treasury routing requires the server-issued authorization; providers must preserve
its exact bounds. The removed composability flags are no longer needed.
See [tests/README.md](tests/README.md) for validation commands and coverage.

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
hops, and at most one server-quoted step. Markets come from the fixed registry,
with no automatic discovery or public graph configuration. aETH and aHYPE routes can combine
CLAMM and one native RFQ or terminal treasury step. Co-signing and execution require
compatible server/router deployments with the matching venue bindings.

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
PropAMM program and config. The client exposes all 12 core pairs, plus sixteen
mainnet aETH/aHYPE directions when `directRfqQuoteProvider` is configured.
Supply a reader and optional RFQ providers for the selected
network; there is no testnet fallback.
Account validation, PDA/ATA derivation and instructions use the selected deployment.

Both client methods return `RouterSwapQuote`, containing `inputMint`, `outputMint`,
`amountIn`, `estimatedAmountOut`, `minAmountOut`, `hops`, and `deadlineMs`. Amounts use raw `bigint` units and
addresses use base58 strings.

`instructions` is the complete SDK bundle. `rfq: { quoteId }` is present when
server co-signing is required, including treasury mints. Returned quotes omit
`execution`; its optional type value is `"router"`. `SwapQuote` and
`ServerTransactionSwapQuote` remain exported as compatibility types; the client
does not return the server's original transaction.
See [the direct RFQ provider contract](#direct-rfq-provider-contract) for submission behavior.

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

Both methods support all 12 core pairs. The sixteen optional aETH/aHYPE directions
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
With PropAMM enabled, a swap quote also makes one RFQ provider call. aETH/aHYPE buys
and sells make zero account reads for aUSD, one four-account USD-vault batch for
primeUSD, and two batches for aBTC or primeBTC. Each uses one direct RFQ provider call.
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
const message = compileRouterMessage(quote.instructions, request.user, recentBlockhash);
// Sign this message with the user's wallet. quote.rfq selects RFQ server submission.
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
router RFQ paths, and the earlier aETH server-transaction API using offline
fixtures. That historical check predates automatic aETH routing. Consumer type
checks cover the packed declarations and private graph boundary. This is
package/runtime compatibility coverage; actual-browser app
integration and live quote generation are separate checks.
The package stays private and exports only its root entry point. Wallet signing
and transport remain application-owned, and graph construction/evaluation stay
internal to the SDK. Step 6 in the dynamic routing plan records final offline
validation and live quote-only results; its two-call follow-up log records the
latest loading changes and offline checks.

## Mainnet aETH and aHYPE routing

Configure the direct RFQ provider to enable aETH and aHYPE buys and sells against
all four core assets. There are no composability flags.

```ts
import {
  createRouterClient, MAINNET_AETH_USD,
  type DirectRfqQuoteProvider, type RouterDataSource,
} from "@arch-network/swap-router-sdk";

declare const source: RouterDataSource;
declare const directRfqQuoteProvider: DirectRfqQuoteProvider;
declare const user: string;

const router = createRouterClient({
  network: "mainnet", source, directRfqQuoteProvider,
});
const quote = await router.quoteExactIn({
  inputMint: MAINNET_AETH_USD.baseMint,
  outputMint: router.mints!.primeUSD,
  amountIn: 1_000_000n, // 0.001 aETH, with 9 decimals.
  slippageBps: 100, user, deadlineMs: Date.now() + 30_000,
});
// Compile quote.instructions with compileRouterMessage and a fresh blockhash.
// User-sign that complete message and submit it with quote.rfq!.quoteId.
```

Use the exported `MAINNET_AHYPE_USD` metadata for HYPE requests; both assets
have 9 decimals. For example, with the same router/provider:

```ts
import { MAINNET_AHYPE_USD } from "@arch-network/swap-router-sdk";

const hypeBuy = await router.quoteExactIn({
  inputMint: router.mints!.primeUSD, outputMint: MAINNET_AHYPE_USD.baseMint,
  amountIn: 1_000_000n, slippageBps: 100, user, deadlineMs: Date.now() + 30_000,
});
```

The provider receives the selected native aETH/aUSD or aHYPE/aUSD leg, including its estimated input
after any redemption or CLAMM prefix. Sells always use native PropAMM terms;
buys resolve into a native swap or terminal treasury mint according to the
validated server packet. The original response remains unchanged. Each route
makes one quote request, with slippage applied once to the final output.
aETH/aHYPE receive sizing remains unsupported. aETH ↔ aHYPE requires two
RFQs and remains excluded by the single-quoted-step contract.

## Direct RFQ provider contract

`DirectRfqQuoteProvider` is application-owned. Its `quoteExactIn` receives a full
`QuoteExactInRequest`, including `slippageBps` and `deadlineMs`, and returns:

```ts
interface DirectRfqQuote {
  transaction: RuntimeTransaction; // Original unsigned server transaction.
  quoteId: string;
  expiresAtMs: bigint; // Unix milliseconds from the server.
  estimatedAmountOut: bigint; // Raw output token units.
  treasuryAuthorization?: { // Required on treasury packets; omitted on native swaps.
    version: 1;
    minAmountIn: bigint;
    maxAmountIn: bigint;
  };
}
```

For treasury buys, copy the server's `treasury_authorization.version`,
`min_amount_in` and `max_amount_in` into this object, decoding the decimal-string
amounts losslessly. Missing authorization rejects with `INVALID_RFQ` before a
routed quote is returned. The SDK preserves the exact issued bounds, including
an explicitly issued fixed interval. It never infers bounds from the nominal
payment or the current policy. Existing HTTP providers must forward this new
metadata. Native packets must omit it.

The client validates the original packet's programs, accounts, amounts, signer
privileges, expiry and transaction limits before building `[input ATA, router]`.
Each provider call has a two-second timeout. Invalid packets, missing metadata,
provider errors and expiry propagate without retries or a direct fallback.
Clients without this provider retain the 12 core pairs; testnet ignores it.

Both quote methods return `RouterSwapQuote`. Existing consumers should remove
`composableAethSells`/`composableAethBuys` and compile `quote.instructions` instead
of signing `quote.transaction`. For example:

```ts
import { compileRouterMessage, type RouterSwapQuote } from "@arch-network/swap-router-sdk";

declare const quote: RouterSwapQuote;
declare const user: string;
declare const recentBlockhash: Uint8Array;

const message = compileRouterMessage(quote.instructions, user, recentBlockhash);
// Sign this complete message with the user's wallet, then submit the flat
// transaction to /rfq/swap with quote_id: quote.rfq!.quoteId.
```

The signing server must trust the matching router and any vault/CLAMM venues.
It adds a read-only quote-signer signature for native swaps or a writable
treasury-authority signature for treasury mints. Treasury deadlines are clamped
to the start of the quote's expiry second, matching on-chain execution.
The SDK does not own HTTP transport, wallet signing, submission or confirmation.

The [working example](examples/README.md) wires those callbacks and supports
explicit retries. Its provider can also be used with `createRouterClient` for
all sixteen aETH/aHYPE routes. `createDirectRfqProvider` handles both markets;
`createAethUsdRfqProvider` remains an alias for existing consumers. See [validator replay coverage](tests/fixtures/propamm-clamm/README.md)
for structural checks against the server. Signature verification and funded
execution are separate from that replay.
`deadlineMs` on a server-transaction result is a client submission deadline;
it must not be written into the original message. The SDK does not own HTTP
transport, wallet signing or submission.

See [AETH_AUSD_SDK_HANDOVER.md](AETH_AUSD_SDK_HANDOVER.md) for the fixed deployment,
HTTP provider mapping, signing/submission contract and offline verification evidence.
The [working example](examples/README.md) wires HTTP, wallet signing, submission,
confirmation and explicit retries; its mocked tests cover both directions.

## Limit orders

PropAMM limit orders are native PropAMM accounts on direct PropAMM vault markets.
They do not use the router program or `createRouterClient`; treasury-mint
markets are excluded. The SDK builds the owner's create and cancel instructions
locally. It reads order accounts only through the injected `RouterDataSource`,
and reaches the order server only through an injected `LimitOrderProvider`.
Program and config addresses come from `LIMIT_ORDER_DEPLOYMENTS[network]`, which
is the network's existing PropAMM deployment. Every helper takes
`{ network }`, which defaults to `"testnet"`.

**Lifecycle.**

1. **Create.** The owner signs, pays and is recorded as `rent_refund`. The
   transaction escrows exactly `inputAmount` and fixes `minOutputAmount`. The
   owner also prepays `fillAllowanceLamports` into the order account.
2. **Open.** The order waits for a fill or a cancel. Fills are full, with exact
   input. There are no partial fills and no expiry.
3. **Fill.** The PropAMM quote signer signs, and any payer funds the
   transaction; the owner does not sign. The program pays the owner the
   post-skew output and rejects payouts below `minOutputAmount`. The payer
   receives the allowance.
4. **Cancel.** The owner signs and pays. The escrow, its rent and the unused
   allowance return to the owner's input ATA and to `rent_refund`.

Filled and cancelled accounts are kept, along with `closedAt` and the actual
`outputAmount`. That makes them the order history. An order ID is part of the
PDA, so never reuse one for the same owner.

| Transaction | Signers | Fee payer | Lamports |
| --- | --- | --- | --- |
| Create | owner | owner | Order/escrow rent plus the fill allowance, from the owner |
| Fill | quote signer + payer | payer (server trigger, owner, or anyone) | The allowance goes to the payer |
| Cancel | owner | owner | Rent and the unused allowance go back to `rent_refund` |

```ts
import {
  buildCancelLimitOrderInstruction, buildCreateLimitOrderInstruction, compileRouterMessage,
  generateLimitOrderId, loadLimitOrder, previewLimitOrder,
  type LimitOrderProvider, type RouterDataSource,
} from "@arch-network/swap-router-sdk";

declare const provider: LimitOrderProvider; // Application-owned HTTP adapter.
declare const source: RouterDataSource;
declare const owner: string;
declare const recentBlockhash: Uint8Array;

const config = await provider.config();
const market = config.markets.find((m) => m.baseSymbol === "aBTC" && m.quoteSymbol === "aUSD");
const form = { side: "buy", inputAmount: 100_000_000n, limitPrice: "95000" } as const;
const preview = previewLimitOrder({ ...form, market, fillFeeLamports: config.fillFeeLamports });
if (!market || preview.errors.length) throw new Error(preview.errors.map((e) => e.message).join(" "));

const { instruction, order } = buildCreateLimitOrderInstruction({
  ...form, network: "mainnet", owner, market,
  baseDecimals: market.baseDecimals, quoteDecimals: market.quoteDecimals,
  orderId: generateLimitOrderId(), fillAllowanceLamports: preview.fillAllowanceLamports,
});
const message = compileRouterMessage([instruction], owner, recentBlockhash);
// The owner signs and submits the message. Later, to cancel:
const open = await loadLimitOrder(source, order, { network: "mainnet" });
if (open?.status === "open") buildCancelLimitOrderInstruction(open, { network: "mainnet" });
```

`buildCreateLimitOrderInstruction` takes either `limitPrice` with both token
decimals, or an explicit `minOutputAmount`. It returns `{ instruction, order,
escrow, minOutputAmount }`. `buildCancelLimitOrderInstruction` needs the decoded
open account, because the native refund destination comes from the order. Both
instructions list the IDL's accounts in order, with payer = owner. The message
compiler merges those duplicate keys into one writable signer. The SDK checks
neither balances nor whether the owner's input ATA exists.

`minimumOutputAtLimit(side, inputAmount, price, baseDecimals, quoteDecimals)`
ports native `minimum_output_at_limit` exactly. The price is a positive plain
decimal in whole quote tokens per whole base token, such as `"95000"` or
`"0.00000292"`. Signs, exponents, whitespace, a bare `.` and non-ASCII digits
are rejected. Both sides round up. A malformed price throws `INVALID_LIMIT_PRICE`,
zero input throws `INVALID_AMOUNT`, and exceeding native u128/u64 bounds throws
`MATH_OVERFLOW`. Each `/orders/config` market reports `baseDecimals` and
`quoteDecimals`. The mint accounts hold the same values: aBTC 8, aUSD 6, aETH 9.

`previewLimitOrder` is pure. It takes the pair's `/orders/config` market entry,
which supplies the decimals, along with `side`, `inputAmount`, `limitPrice` and
`fillFeeLamports`. It returns `minOutputAmount` (null when the price or input is
invalid) and the default `fillAllowanceLamports`, which is the server's
`fillFeeLamports`. It also returns every validation error: `BELOW_MINIMUM_INPUT`
and the three math codes. Pass `market: undefined` when the server lists no entry
for the pair. The result is then only `UNSUPPORTED_MARKET` with a null minimum,
because the server neither fills nor signs fills for that market. If an order's allowance is below `fillFeeLamports`,
the trigger never fills it, and the owner must fill it through `fill`.

### Order server provider

`LimitOrderProvider` has three methods. Map each one to the order server as
follows. Convert snake_case fields to camelCase and return every u64 as a
`bigint`. The server sends u64 values as JSON numbers, so decode them
losslessly or reject unsafe integers; the
[aETH example](examples/aeth-usd.ts) shows a strict decoder. Error bodies are
`{"error": message, "code": code}`. Reject on any non-2xx status.

| Method | Endpoint | Result |
| --- | --- | --- |
| `config()` | `GET /orders/config` | `{ triggerEnabled, fillFeeLamports, markets: [{ baseMint, quoteMint, baseSymbol, quoteSymbol, baseDecimals, quoteDecimals, minBuyInput, minSellInput }] }`. Decimals are u32 JSON numbers; return them as `number`. |
| `list({ owner, status?, cursor?, limit? })` | `POST /orders/list` with `{owner, status?: "open" \| "closed", cursor?, limit?}` | `{ orders: LimitOrderSummary[], nextCursor? }`, newest first. `orderId` stays 64-char hex; `closedAt` appears once terminal and `outputAmount` only once filled. |
| `fill({ order, payer })` | `POST /orders/fill` with `{order, payer}` | `{ order, transaction, payerSignatureIndex, outputAmount, minOutputAmount, expiresAtMs }`. A 422 with `order_not_fillable` means the order is closed, missing, below the minimum, or the price or inventory is not met yet. |

`list` reads history from chain. It pages with `nextCursor`, and `limit`
defaults to 50 with a maximum of 100. Fills come from the server trigger when
`triggerEnabled` is set and the allowance covers `fillFeeLamports`. Otherwise
any payer, usually the owner, calls `fill`. Its `transaction` is a
maker-signed `RuntimeTransaction`, with the payer's slot at `payerSignatureIndex`
zeroed. Sign the message unchanged and fill that slot. Then send it to the
node yourself before `expiresAtMs`; the server never sends it. The SDK does not
validate this transaction. Before signing, check that it contains a single
PropAMM `fill_limit_order` instruction for the expected order. The server's
`POST /orders/create` and `/orders/cancel` builders are not needed.

The ABI, layout, PDA and math tests use native PropAMM fixtures; see
[tests/fixtures/limit-orders](tests/fixtures/limit-orders/README.md). They do
not show that limit orders are deployed on either network.


### Explicit RFQ market catalogs

Existing callers that pass only `directRfqQuoteProvider` keep the built-in
mainnet ETH/USD and HYPE/USD markets. To select other markets, pass
`directRfqDeployment` with the maker's `programId`, `config` and `quoteSigner`,
and `directRfqMarkets` with each pair's `baseMint`, `quoteMint` and allowed
`sides`, `buy` or `sell`. The explicit list replaces the built-in direct catalog.
An empty list enables no direct RFQ markets. A deployment without a list also
enables none. Configured markets require the provider to enter the routing graph
and are mainnet-only, like the existing direct RFQ integration.

Inventory markets need no treasury settings. Treasury execution requires both
`treasuryAuthority` and `bridgeProgramId`, plus the server-issued authorization
already required by the router. Custody accounts are derived from the maker
configuration and mints, and token program identities come from the network.
The caller supplies trusted identities independently of the quote response.
A configured BTC/USD market takes precedence over the legacy BTC/USD RFQ provider
when both providers are supplied. CLAMM remains a candidate.
