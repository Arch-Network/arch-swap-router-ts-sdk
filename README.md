# Arch swap router TypeScript SDK

Scaffold for `@arch-network/swap-router-sdk`. Routing, account reads, quoting,
encoding, and instruction construction are not implemented. Calling
`quoteRoutesExactIn` rejects with `NotImplementedError`; it performs no RPC calls.

The base dependency is [`@arch-network/arch-sdk`](https://github.com/Arch-Network/arch-typescript-sdk),
pinned to `0.0.28`. This scaffold has not established live program compatibility.

Start with [HANDOVER.md](HANDOVER.md) for the implementation sequence, SDK reuse
map, frontend integration contract, and verification checklist.

## Development

Use Node 20.19+ in the 20.x line, or Node 22.12+, and pnpm 10.12.4.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

The test suite is intentionally empty until SDK behavior is implemented.

## Public API

`createRouterClient` constructs a client with one swap method:
`quoteRoutesExactIn`. Its planned result is a capped list of quotes ranked by
estimated final output, each with an instruction bundle, plus a response timestamp.

```ts
import {
  createRouterClient,
  TESTNET,
  TESTNET_MINTS,
  TESTNET_VENUES,
  type RouterDataSource,
} from "@arch-network/swap-router-sdk";

// Supply the application's RPC or indexer account reader.
declare const source: RouterDataSource;
declare const walletAddress: string;

const router = createRouterClient({
  deployment: TESTNET,
  venues: TESTNET_VENUES,
  source,
});

// Placeholder: this currently rejects with NotImplementedError.
const result = await router.quoteRoutesExactIn({
  inputMint: TESTNET_MINTS.aUSD,
  outputMint: TESTNET_MINTS.primeBTC,
  amountIn: 1_000_000n,
  slippageBps: 50,
  user: walletAddress,
  deadlineMs: Date.now() + 120_000,
  limit: 3,
});
```

Amounts are raw `bigint` units. Addresses are base58 strings; validation remains a
placeholder. The response timestamp uses Unix seconds; `deadlineMs` uses Unix
milliseconds. The injected reader returns the Arch SDK's `AccountInfoResult` directly, with
`owner` and `data` as bytes and the existing `is_executable` field. The caller
manages quote refresh, blockhashes, transaction assembly,
wallet signing, submission, and retries.

There are no public route-discovery, single-route quote, or standalone builder
methods. Only the root package entry point is exported.

## Structure

```text
src/
  index.ts                Explicit public exports
  client.ts               Client factory and placeholder wiring
  types.ts                Public requests, results, configuration, and transport
  config/                 Testnet venue registry and protocol constants
  errors/                 SDK errors and NotImplementedError
  accounts/               Account-reader and ATA-address placeholders
  codecs/                 Router instruction/result types and codec placeholders
  venues/                 Mint, Redeem, CLAMM adapters and future PropAMM slot
  quotes/                 Discovery, quoting, and ranking placeholders
  transactions/           Instruction-bundle and signed-size placeholders
tests/                    Future contract and integration fixtures
```

The testnet registry configures venues, not routes. PropAMM is not registered.
Mainnet has no deployment preset.

The design is maintained in the sibling router repository:
[SDK plan](../arch-swap-router/arch-swap-router-sdk-plan.md). No live account state
or quote math is vendored in this scaffold.
