# aETH/aUSD router swap example

[aeth-usd.ts](aeth-usd.ts) exports `createAethUsdRfqProvider` and
`prepareAethUsdSwap`. It performs no work on import. HTTP, account reading,
fresh blockhashes, wallet signing and confirmation are supplied by the app.
Both native buys and sells use router instructions automatically.

## Quote routes

```ts
import { createRouterClient, MAINNET_AETH_USD } from "@arch-network/swap-router-sdk";
import { createAethUsdRfqProvider } from "./aeth-usd.js";

const router = createRouterClient({
  network: "mainnet", source,
  directRfqQuoteProvider: createAethUsdRfqProvider(`${options.serverUrl}/rfq`, options.post),
});
const sell = await router.quoteExactIn({
  inputMint: MAINNET_AETH_USD.baseMint, outputMint: router.mints!.primeBTC,
  amountIn: 1_000_000n, slippageBps: 100, user, deadlineMs: Date.now() + 30_000,
});
const buy = await router.quoteExactIn({
  inputMint: router.mints!.aBTC, outputMint: MAINNET_AETH_USD.baseMint,
  amountIn: 1_000n, slippageBps: 100, user, deadlineMs: Date.now() + 30_000,
});
```

The mainnet provider automatically enables all eight aETH directions and
20 unique pairs overall. There are no `composableAethSells` or
`composableAethBuys` options. Both results contain `instructions` ready for
router compilation. aETH receive sizing remains unsupported.

The aETH/aUSD native RFQ uses one HTTP request per route. Account reads are
zero for direct aETH/aUSD, one for primeUSD and two for either BTC asset.
The provider receives the native leg's amount after any prefix and the SDK
applies slippage once to final output. It preserves the original RFQ response.

Native buys need aETH vault inventory and a server issuing native Buy quotes.
The last live check received treasury packets, which this flow rejects.
The running server's market mode/deployment must be aligned before buys pass
live. Treasury minting remains a future graph edge.

## Wire the callbacks

```ts
import { MAINNET_AETH_USD as market, type RouterDataSource } from "@arch-network/swap-router-sdk";
import { prepareAethUsdSwap, type AethUsdExampleOptions } from "./aeth-usd.js";

declare const source: RouterDataSource;
declare const user: string;
// Use your application's Arch RPC and wallet integrations.
declare const getRecentBlockhash: AethUsdExampleOptions["getRecentBlockhash"];
declare const signMessage: AethUsdExampleOptions["signMessage"];
declare const confirm: AethUsdExampleOptions["confirm"];

const options: AethUsdExampleOptions = {
  serverUrl: "https://vaults.veloxapi.net/propamm",
  source, getRecentBlockhash, signMessage, confirm,
  async post(url, body) {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(1800),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`RFQ HTTP ${response.status}: ${raw}`);
    return raw;
  },
};

const prepared = await prepareAethUsdSwap(options, {
  inputMint: market.quoteMint, outputMint: market.baseMint,
  amountIn: 1_000_000n, slippageBps: 100, user, deadlineMs: Date.now() + 30_000,
});
// Review prepared.quote and prepared.transaction before invoking the wallet.
const transactionHash = await prepared.submitAndConfirm();
```

Reverse the mints to sell, using the raw aETH amount (9 decimals; aUSD has 6).
The helper supports the fixed aETH/aUSD pair; use `createRouterClient` directly
for routes to/from BTC and prime tokens.

`getRecentBlockhash` returns a fresh 32-byte `Uint8Array`. The helper compiles
the complete router bundle with that hash and the validated user, and returns
an unsigned `prepared.transaction`. `signMessage` receives that compiled Arch
message and returns only the user's 64-byte signature. `/rfq/swap` receives the
flat transaction with its `quote_id`, then adds the maker signature. `confirm`
must resolve on confirmed success and reject execution failures or uncertainty.

## Deadlines and retries

Preparation checks quote freshness again after fetching the blockhash. Submission
checks it before opening the wallet and after signing. Mutating the prepared
transaction before or during signing rejects with `MESSAGE_CHANGED`.

An uncertain submission can be retried explicitly with `submitAndConfirm()`
before expiry. It reuses the identical cached signed body and quote ID, including
its original blockhash. Concurrent attempts share the same in-flight promise.
After a transaction hash is known, retries only confirm it, including after
quote expiry. A fresh quote creates a new potential trade; reconcile an
uncertain prior submission before preparing another one.

The example keeps retry state in memory. Persist the exact signed body and
quote ID in application storage if retries must survive reloads.

## Amounts and verification

The HTTP adapter writes input u64 values as JSON numeric literals without a
`Number` conversion. Native Buy/Sell expiry is read losslessly from instruction
bytes; optional expiry metadata must match. Unsafe numeric JSON output metadata
is rejected. Use a lossless decoder for output values above the safe-integer
range. Byte arrays and account indexes are validated before normalization.

User input must be funded. The router handles missing intermediate/output ATAs.
Native buys require aETH maker inventory; sells require aUSD inventory. The
server must trust the matching router, vault and CLAMM deployments. The original
native server message is validated and retained unchanged while the helper
constructs the router message that the user signs.

Run the mocked examples and typecheck from the SDK root:

```sh
corepack pnpm exec vitest run tests/examples/aeth-usd.test.ts tests/examples/aeth-native-buy.test.ts
corepack pnpm typecheck
```

The tests use independent native Rust fixtures, fake wallet signatures and
mocked HTTP/RPC callbacks. No signatures are sent to mainnet. This example is
source for the consuming app; when copying it outside the checkout, replace
its `../src/index.js` import with `@arch-network/swap-router-sdk`.
