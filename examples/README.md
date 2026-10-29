# aETH/aUSD swap example

[aeth-usd.ts](aeth-usd.ts) implements the fixed mainnet quote → validate → sign →
submit → confirm flow. It uses the SDK's public entry point and exports
`prepareAethUsdSwap`. It performs no work on import. HTTP, the existing Arch
wallet signing flow, account reading and confirmation are supplied by the app.
The two new directions do not call the account reader.

Run the offline example tests from the SDK root:

```sh
corepack pnpm exec vitest run tests/examples/aeth-usd.test.ts
corepack pnpm typecheck
```

The tests use the pinned unsigned Rust buy/sell fixtures, fake 64-byte signatures,
mocked HTTP and confirmation. They send no requests to mainnet. The example is
source for the consuming app, rather than an additional SDK package export.
When copying it outside this checkout, replace its `../src/index.js` import
with `@arch-network/swap-router-sdk`.

## Wire the callbacks

```ts
import { MAINNET_AETH_USD as market } from "@arch-network/swap-router-sdk";
import { prepareAethUsdSwap, type AethUsdExampleOptions } from "./aeth-usd.js";

declare const user: string; // Current mainnet wallet, base58.
declare const source: AethUsdExampleOptions["source"]; // Existing mainnet reader.
declare const signMessage: AethUsdExampleOptions["signMessage"];
declare const confirm: AethUsdExampleOptions["confirm"];

const options: AethUsdExampleOptions = {
  serverUrl: "http://18.88.43.115:3002", source, signMessage, confirm,
  async post(url, body) {
    const response = await fetch(url, { method: "POST",
      headers: { "content-type": "application/json" }, body });
    const text = await response.text();
    if (!response.ok) throw new Error(`RFQ HTTP ${response.status}: ${text}`);
    return text;
  },
};

// Prepare one direction at a time, in response to the user's swap action.
function prepareBuy() {
  return prepareAethUsdSwap(options, {
    inputMint: market.quoteMint, outputMint: market.baseMint,
    amountIn: 1_000_000n, // Spend 1 aUSD, in raw 6-decimal units.
    slippageBps: 100, user, deadlineMs: Date.now() + 30_000,
  });
}
function prepareSell() {
  return prepareAethUsdSwap(options, {
    inputMint: market.baseMint, outputMint: market.quoteMint,
    amountIn: 1_000n, // Spend 0.001 aETH, in raw 6-decimal units.
    slippageBps: 100, user, deadlineMs: Date.now() + 30_000,
  });
}

const prepared = await prepareBuy(); // Or prepareSell().
// Present prepared.quote.estimatedAmountOut and .minAmountOut for review.
// From the user's confirmed action:
const transactionHash = await prepared.submitAndConfirm();
```

`signMessage` must sign the supplied original message with the application's
Arch wallet integration and return the user's 64-byte signature. The example
does not compile instructions, replace blockhashes or create another transaction.
`confirm` must resolve on confirmed success and reject on failed execution or
uncertain confirmation. It owns polling/timeouts; `post` owns HTTP errors,
timeouts and any proxy needed by the application.

## Deadlines and retries

`prepareAethUsdSwap` obtains and validates the quote without opening the wallet.
`submitAndConfirm()` checks the clamped client/server deadline before wallet
signing and before sending `/rfq/swap`. The original message is checked before
and after the wallet callback. A changed message or invalid signature is rejected
before submission.

On an uncertain submission response, keep the same `prepared` object and call
`prepared.submitAndConfirm()` again before expiry. It reuses the identical cached
JSON body: original message, blockhash, quote ID, version and user signature.
There are no automatic retries. Concurrent calls share one operation.
When a transaction hash is known, another call only repeats confirmation, even
after quote expiry; it does not re-sign or re-submit.

Without a known hash, expiry rejects with `RFQ_EXPIRED`. Reconcile any uncertain
prior execution before preparing another swap; a fresh quote is a new potential
trade. Obtain a new quote rather than modifying the previous blockhash. The
example keeps retry state in memory; an app that needs retries across reloads
must persist the exact signed body and quote ID using its own storage.

## Amounts and account creation

The HTTP request writes `amountIn` directly as a JSON numeric u64 literal without
converting it to `number`. The compact response decoder uses `JSON.parse` and
rejects output/expiry metadata that is not a nonnegative safe integer before
conversion to `bigint`. This example supports ordinary safe-size server amounts;
replace its decoder with a lossless JSON adapter for larger output/expiry
values. It never converts a rounded unsafe number into an accepted `bigint`.
Byte values and account indexes are range-checked before normalization.

Both tokens use 6 decimals. Use `MAINNET_AETH_USD`; `router.mints` has no aETH
(its aUSD is the same mint as `MAINNET_AETH_USD.quoteMint`). The SDK returns the exact minted payout for buys and the
validated signed minimum for sells. Other pairs and receive sizing are outside
this example.

A buy requires an existing funded aUSD input ATA. Its bridge instruction
contains the aETH output ATA and token/ATA/system programs for output creation.
A sell carries the nonce and both ATAs plus creation programs; empty input
accounts still lack the aETH balance required to execute. Sells require aUSD
vault liquidity, and creation/transaction fees must be funded. The example
forwards these native layouts unchanged and adds no ATA instructions. Actual
missing-output-account creation remains a funded runtime smoke check, rather
than a claim established by the mocked HTTP tests.

The server's quote ID, transaction fields and signature are submitted as
top-level fields, not under a nested `transaction`. The server supplies the
second signature and broadcasts. See the
[SDK handoff](../AETH_AUSD_SDK_HANDOVER.md) for deployment pins and full mappings.
