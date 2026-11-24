# Native swap application example

[native-swap.ts](native-swap.ts) exports `executeNativeSwapExample`. The app
supplies a `SwapClient`, an input-budget request, quote review, a wallet message
signer, and chain confirmation. Importing the example performs no work.

The example obtains one complete quote, waits for application review, checks
expiry before opening the wallet, attaches the returned user signature, submits
through PropAMM, and confirms the acknowledged transaction hash through the app.
The SDK checks freshness and message integrity again after the wallet prompt.
It never recompiles the packet, refreshes its blockhash, or fills treasury slots.

A lost submit response rejects with `SwapSdkError.submissionUncertain`. Persist
the quote ID, explicitly query `client.getAttempt(quoteId)`, and reconcile the
hash on chain before authorizing another trade. A missing attempt is not proof
that nothing was broadcast. The example does not retry or refresh automatically.

The public HTTP adapter accepts a service URL or browser proxy path and optional
standard `fetch`. Its methods accept an `AbortSignal`. Wallets and confirmation
remain application callbacks, with no wallet-library dependency in the SDK.

Run the mocked example with:

```sh
corepack pnpm exec vitest run tests/examples/native-swap.test.ts
corepack pnpm typecheck
```

The example is repository source. When copying it into a consuming app, replace
its `../src/index.js` import with `@arch-network/swap-router-sdk`.
