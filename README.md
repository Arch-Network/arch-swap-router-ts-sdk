# Arch swap router TypeScript SDK

A compact, browser-oriented SDK for fixed-pair swap estimates and router
instructions on Arch. Testnet and mainnet swaps are configured; mainnet vaults
and prime tokens remain placeholders.
One quote call returns one estimate with its
instructions, sized from either a fixed input or an approximate receive amount.
Supported pairs use explicit one-to-three-hop routes
through the two vaults and the aBTC/aUSD CLAMM, with optional PropAMM RFQs for
exact-input swaps on either network.

**Current status:** all 12 fixed directions have estimates and instructions,
including direct CLAMM and two-/three-hop routes. Unsupported or identical mint
pairs reject with `UNSUPPORTED_PAIR` before reads. Frontend/package verification
is the remaining implementation checkpoint.

See [SIMPLIFICATION_PLAN.md](SIMPLIFICATION_PLAN.md) for the agreed scope,
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for progress, and
[HANDOVER.md](HANDOVER.md) for implementation references. The narrower PropAMM
extension is specified in [PROPAMM_ROUTER_SDK_HANDOVER.md](PROPAMM_ROUTER_SDK_HANDOVER.md).

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

Mainnet's router, CLAMM pool/program, PropAMM deployment and aBTC/aUSD mints are
configured in [src/config/networks.ts](src/config/networks.ts). Its CLAMM pool
orders aUSD as token A and aBTC as token B, the reverse of testnet.
The vault program, vault accounts and prime-token mints remain **placeholders**;
replace those before using mainnet vault routes. The client still exposes all
12 fixed pairs. Supply a reader and optional RFQ provider for the selected
network; there is no testnet fallback.
Account validation, PDA/ATA derivation and instructions use the selected deployment.

The `SwapQuote` contains `inputMint`, `outputMint`, `amountIn`,
`estimatedAmountOut`, `minAmountOut`, `instructions`, and `deadlineMs`, plus
`rfq: { quoteId }` only when PropAMM wins.
Amounts use raw `bigint` units and addresses use base58 strings.

`quoteForOutput` finds the smallest valid input whose estimated output reaches
`amountOut`. Integer rounding can make the estimate larger than the requested
amount. It returns the same `SwapQuote`, with the calculated fixed `amountIn`;
slippage is applied once to `estimatedAmountOut`. For an estimate of 100 tokens
and 50 BPS slippage, the minimum is 99.5 tokens, subject to raw-unit rounding.
This is approximate receive sizing: execution spends the fixed input and may
receive less than the target within slippage. It is not exact-output execution
with a maximum-input allowance.

Both methods support all 12 pairs. Receive sizing reuses the fetched, decoded
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

These budgets apply without an RFQ provider and to every `quoteForOutput` call.
With PropAMM enabled, a swap quote adds one RFQ call. Direct swaps still use two
reader calls. Routes with vaults use three: shared vault state, remaining CLAMM
pool/mints, then ticks. Each account is fetched only once. Separating the shared
vault batch lets a CLAMM read/validation failure leave PropAMM available.

Only confirmed account absence should return `null`; resolve indexer cache misses
in the application reader. CLAMM treats absent or empty system-owned tick accounts
as uninitialized arrays, matching the native program.

Mint checks pause, NAV freshness, fees and the full-deposit cap. Redeem requires
an empty observed queue and enough reserve for the gross claim. Both use the
observed share supply; management fees accrue in native `Report`. Estimates use
raw units, native rounding and one final slippage floor. Concurrent state can
change before execution; native immediate-fill-or-abort support is still pending.

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

The application owns quote refresh, final transaction sizing and compilation,
blockhashes, signing, submission, deadline handling, and confirmation. The SDK
provides estimates and instruction encoding, not execution preflight.

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

`quoteExactIn` compares at most two candidates along the existing fixed path.
Higher final output, including vault fees and rounding, wins; CLAMM wins ties.
Each RFQ waits at most **2 seconds**, without retries. A declined, invalid,
expired or oversized RFQ leaves CLAMM available; a CLAMM-specific failure leaves
PropAMM available. Required shared-vault failures invalidate both. Direct vault
quotes and `quoteForOutput` never call the provider.

The PropAMM deadline is `min(request.deadlineMs, terms.expiryMs)`, rechecked at
selection. Original compact terms are preserved. The SDK checks the compiled
PropAMM bundle against 1,232 bytes, including two 64-byte signatures; callers
must recheck if they alter it. The native three-hop fixture is 1,225 bytes with
shared fee destinations; other fee accounts can make it too large.

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

PropAMM uses the v2 config (`PROPAMM2`, version 2) and config-owned vaults.
The configured config addresses assume migration with each deployment's current
signer. Migrate and fund the v2 vaults and deploy a compatible router before using
this SDK version. Vault seeds are `["vault", config, mint]`; config and nonce
addresses stay fixed during subsequent signer rotations. Only `quoteSigner`
changes between quotes, so rotation needs no SDK release or additional RPC read.

For an RFQ winner, compile with **`compileRouterMessage`**, which corrects
arch-sdk 0.0.28's insertion ordering to the Rust account ordering required by the
signing server. Sign the resulting router message with the user, then send
`POST /rfq/swap` with `{ quote_id: quote.rfq.quoteId, version: 0,
signatures: [userSignature], message }` in the server's JSON transaction format
(Arch SDK's `TransactionUtil.toNumberArray` provides that representation).
The server validates it, adds the read-only maker's signature and broadcasts,
returning `{ transaction_hash }`. Do not reuse the standalone RFQ message.
Once submission binds the quote, retries must use the identical message; a new
blockhash or route requires a fresh quote. The SDK does not sign or submit.

After redemption, PropAMM accepts measured input only within
`ceil(quotedInput * 9950 / 10000) .. quotedInput`. Execution outside that range
fails atomically; the SDK does not pad/cap the input or consume existing
intermediate balances. There is no post-signing venue fallback.

This integration is verified offline. Live use requires compatible
router and RFQ signing-server deployments; source availability does not confirm
deployment.

## Development

Use Node 20.19+ in the 20.x line or Node 22.12+. Dependencies remain pinned to
`@arch-network/arch-sdk@0.0.28` and `@scure/base@1.2.6`, with pnpm 10.12.4.

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

Package/browser verification and live smoke coverage remain later work. The
package stays private, exports only its root entry point, and has no wallet,
transport, graph-discovery, or ranking framework.
