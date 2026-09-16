# Arch swap router TypeScript SDK

A compact, browser-oriented SDK for fixed-pair swap estimates and router
instructions on Arch testnet. One `quoteExactIn` call returns one estimate
with its instructions. Supported pairs use explicit one-to-three-hop routes
through the two vaults and the aBTC/aUSD CLAMM.

**Current status:** aBTC ↔ primeBTC and aUSD ↔ primeUSD quotes and instructions
work using one batch of four accounts (vault, both mints, reserve). CLAMM and
multi-hop quotes remain `NOT_IMPLEMENTED`; unsupported or identical mint pairs
reject with `UNSUPPORTED_PAIR`. Those rejected routes perform no reads.

See [SIMPLIFICATION_PLAN.md](SIMPLIFICATION_PLAN.md) for the agreed scope,
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for progress, and
[HANDOVER.md](HANDOVER.md) for implementation references.

## Frontend API

```ts
import {
  createRouterClient,
  SUPPORTED_PAIRS,
  TESTNET_MINTS,
  type RouterDataSource,
} from "@arch-network/swap-router-sdk";

// The application supplies its normalized, batched indexer/RPC reader.
declare const source: RouterDataSource;
declare const walletAddress: string;

const router = createRouterClient({ source });

// SUPPORTED_PAIRS lists the 12 supported inputMint/outputMint combinations.
const swap = await router.quoteExactIn({
  inputMint: TESTNET_MINTS.aUSD,
  outputMint: TESTNET_MINTS.primeUSD,
  amountIn: 1_000_000n,
  slippageBps: 50,
  user: walletAddress,
  deadlineMs: Date.now() + 120_000,
});
```

The `SwapQuote` contains `inputMint`, `outputMint`, `amountIn`,
`estimatedAmountOut`, `minAmountOut`, `instructions`, and `deadlineMs`.
Amounts use raw `bigint` units and addresses use base58 strings.

The reader returns ordered `AccountInfoResult | null` values with `owner` and
`data` normalized to `Uint8Array`; malformed responses and transport failures
reject. Each quote reads fresh state, and building adds no fetches. One SDK batch
is one HTTP request only if the application's reader/provider supports it.

Mint checks pause, NAV freshness, fees and the full-deposit cap. Redeem requires
an empty observed queue and enough reserve for the gross claim. Both use the
observed share supply; management fees accrue in native `Report`. Estimates use
raw units, native rounding and one final slippage floor. Concurrent state can
change before execution; native immediate-fill-or-abort support is still pending.

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

Tests verify the fixed registry, client behavior, native instruction bytes,
account positions/privileges, PDA/ATA derivation, and result framing. They do not
establish live compatibility. Fixtures retain their original Rust provenance;
the SDK compares the router instruction within the original two-instruction
fixtures and no longer checks transaction size.

Package/browser verification and live smoke coverage remain later work. The
package stays private, exports only its root entry point, and has no wallet,
transport, graph-discovery, or ranking framework.
