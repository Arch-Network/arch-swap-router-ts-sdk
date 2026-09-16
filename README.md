# Arch swap router TypeScript SDK

A compact, browser-oriented SDK for fixed-pair swap estimates and router
instructions on Arch. Testnet is configured; mainnet is a selectable placeholder.
One quote call returns one estimate with its
instructions, sized from either a fixed input or an approximate receive amount.
Supported pairs use explicit one-to-three-hop routes
through the two vaults and the aBTC/aUSD CLAMM.

**Current status:** all 12 fixed directions have estimates and instructions,
including direct CLAMM and two-/three-hop routes. Unsupported or identical mint
pairs reject with `UNSUPPORTED_PAIR` before reads. Frontend/package verification
is the remaining implementation checkpoint.

See [SIMPLIFICATION_PLAN.md](SIMPLIFICATION_PLAN.md) for the agreed scope,
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for progress, and
[HANDOVER.md](HANDOVER.md) for implementation references.

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

`createRouterClient({ network: "mainnet", source })` succeeds today, with
`mints: null` and `supportedPairs: []`. Both quote methods throw
`RouterSdkError` with code `NETWORK_NOT_CONFIGURED` before any account reads.
There is no testnet fallback. Fill the `mainnet` entry in
[src/config/networks.ts](src/config/networks.ts) with its program IDs, mints and
venues when available. Routes use the selected mints; account validation,
PDA/ATA derivation and instructions use the selected program IDs.

The `SwapQuote` contains `inputMint`, `outputMint`, `amountIn`,
`estimatedAmountOut`, `minAmountOut`, `instructions`, and `deadlineMs`.
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

The internal builder returns just the router instruction. Its ATA/system trailer
enables the router to create missing user ATAs. There is no separate ATA-creation
or compute-budget instruction. Compute provisioning is separate router/runtime
integration work; removing the extra instruction does not raise the runtime's
default allowance.

The application owns quote refresh, final transaction sizing and compilation,
blockhashes, signing, submission, deadline handling, and confirmation. The SDK
provides estimates and instruction encoding, not execution preflight.

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
result framing. They do not
establish live compatibility. Fixtures retain their original Rust provenance;
the SDK compares the router instruction within the original two-instruction
fixtures and no longer checks transaction size.

Package/browser verification and live smoke coverage remain later work. The
package stays private, exports only its root entry point, and has no wallet,
transport, graph-discovery, or ranking framework.
