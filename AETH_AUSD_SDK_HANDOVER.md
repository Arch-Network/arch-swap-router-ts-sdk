# aETH/aUSD SDK handoff

The SDK supports the fixed mainnet aUSD ↔ aETH market through an injected direct
RFQ provider. Both directions spend a fixed input and return the original unsigned
server transaction. They bypass the on-chain swap router. This completes SDK-1
through SDK-6. The [working example](examples/README.md) now implements the
HTTP/wallet/submission flow with injected callbacks and offline mocked tests.

## Enable the fixed market

Create the client with `network: "mainnet"`, the existing `source`, and
`directRfqQuoteProvider: DirectRfqQuoteProvider`. It advertises 14 pairs: the 12
existing directions plus these two exact-input directions. Use the exported
`MAINNET_AETH_USD` constants for requests; `router.mints` remains the separate
legacy BTC/vault configuration. Both new tokens have 6 decimals.

| Direction | `inputMint` | `outputMint` | Raw input example | Execution / output minimum |
| --- | --- | --- | --- | --- |
| Buy aETH | `MAINNET_AETH_USD.quoteMint` | `MAINNET_AETH_USD.baseMint` | `1_000_000n` = 1 aUSD | aUSD payment + bridge treasury mint; exact encoded aETH payout. |
| Sell aETH | `MAINNET_AETH_USD.baseMint` | `MAINNET_AETH_USD.quoteMint` | `1_000n` = 0.001 aETH | PropAMM `ExecuteTrade`; signed minimum must cover the requested slippage floor. |

Call `quoteExactIn` with these mints, raw `amountIn: bigint`, `slippageBps`, the
user's base58 address, and a safe integer `deadlineMs` in Unix milliseconds.
The [README example](README.md#direct-rfq-transaction-contracts) shows setup and
result narrowing. `quoteForOutput`, aETH/BTC, prime-token compositions and the
old `Bfbd38…` aETH mint are unsupported. The provider is inactive on testnet;
clients without it retain their existing pairs.

The client validates the request before one provider call, bounded to two
seconds, then applies the matching fixed-template validator. It performs no
account reads and does not retry or fall back on another venue. Provider errors
propagate; SDK rejection codes include `INVALID_RFQ`, `RFQ_EXPIRED`,
`RFQ_TIMEOUT`, `TRANSACTION_TOO_LARGE` and `UNSUPPORTED_PAIR`.

## Application-owned HTTP provider

Reference endpoint: `http://18.88.43.115:3002`. The provider maps the SDK request
to `POST /rfq/quote` as follows:

| HTTP request field | Mapping |
| --- | --- |
| `base_mint` | Hex encoding of the 32 decoded bytes of `MAINNET_AETH_USD.baseMint`, in both directions. |
| `quote_mint` | Hex encoding of `MAINNET_AETH_USD.quoteMint`, in both directions. |
| `side` | `"buy"` for aUSD → aETH; `"sell"` for aETH → aUSD. |
| `amount` | `request.amountIn`, as a losslessly encoded JSON u64 numeric literal. Buys spend aUSD; sells spend aETH. |
| `user_pubkey` | Hex encoding of the 32 decoded bytes of `request.user`. |
| `slippage_bps` | `request.slippageBps`; send it explicitly so sells contain the requested signed minimum. |

`deadlineMs` has no corresponding server request field. It remains a client
submission deadline and is clamped to the response's server expiry by the SDK.

The server response has **top-level** `version`, `signatures`, `message`,
`quote_id`, `expires_at_ms` and `estimated_quote`; the transaction is flattened,
rather than nested under a `transaction` field. Return this provider contract:

| `DirectRfqQuote` field | Server response mapping |
| --- | --- |
| `transaction` | `{ version, signatures, message }`, preserving the original message. Convert byte arrays to `Uint8Array` without recompiling. |
| `quoteId` | `quote_id`, unchanged. |
| `expiresAtMs` | Losslessly decoded `expires_at_ms`, as `bigint`. |
| `estimatedAmountOut` | `estimated_quote.base_amount` for buys; `estimated_quote.quote_amount` for sells, as `bigint`. |

Use precision-safe JSON encoding and decoding for u64 values. Ordinary
`response.json()` can round numeric literals before conversion to `bigint`.
Reject unsafe numbers if the adapter cannot preserve them; converting an already
rounded number does not recover the original amount. Even small output/expiry
values must be returned as `bigint` to satisfy the contract.

For the transaction, normalize `account_keys`, `recent_blockhash`, instruction
`data` and any signatures to byte arrays after checking each element is an
integer in 0..255. Keep headers, program indexes and instruction account indexes
as numbers, and preserve all array ordering. The server quote must be unsigned
(`signatures: []`). HTTP error handling, precision-safe codecs, endpoint/proxy
selection and cancellation remain application responsibilities.

## Signing and submission contract

Narrow `SwapQuote` using `quote.execution === "serverTransaction"`. This branch
contains `transaction` and required `rfq.quoteId`; it has no `instructions`.
Existing instruction-based quotes still use `compileRouterMessage`.

For the new branch, use the existing Arch wallet signing flow on the original
`quote.transaction.message`. Preserve the blockhash, account order, privileges,
instruction data and instruction order. Do not call `compileRouterMessage`,
replace the blockhash or append ATA/compute instructions. Check
`Date.now() < quote.deadlineMs` before signing and again before submission.
This client deadline must not be written into the message.

Send `POST /rfq/swap` with top-level `quote_id: quote.rfq.quoteId`,
`version: quote.transaction.version`, `signatures: [userSignature]`, and the
original `message` in the server's numeric-array JSON representation.
`TransactionUtil.toNumberArray` from the pinned Arch SDK provides the transaction
representation. The user's 64-byte signature occupies the first signer slot;
the server adds its treasury-authority signature for buys or quote-signer
signature for sells, broadcasts, and returns `{ transaction_hash }`.

Keep the original message, quote ID and user signature for retries of an
uncertain submission. Obtain a fresh quote after expiry; changing a previous
message's blockhash invalidates that RFQ. Submission and confirmation callbacks
are demonstrated and tested in [examples/aeth-usd.ts](examples/aeth-usd.ts) and
its [mocked execution tests](tests/examples/aeth-usd.test.ts).

## Output-account layouts and execution prerequisites

The buy has two instructions: an APL transfer (3 accounts), then bridge
`MintFromTreasury` (11 accounts). The bridge instruction includes the user's
canonical aETH ATA plus the token, ATA and system programs for its output-account
creation path. The input aUSD ATA must already exist and hold the payment; the
transfer precedes the mint. Minted buys do not draw aETH from the PropAMM vault.

The sell has one 50-byte `ExecuteTrade` instruction with all 13 accounts. It
includes both user ATAs, both mints, the user nonce, and token/system/ATA programs.
The pinned PropAMM implementation creates the nonce and user ATAs when needed
before checking balances. Creating an empty input ATA does not supply the aETH
balance needed for a sell. Sells require aUSD vault liquidity. Account-creation
and transaction fees must also be funded according to the deployed programs.

The SDK checks these complete layouts and their privileges without querying
account existence. Offline tests establish the layouts; funded account creation
and live execution remain rollout checks. The unchanged native buy/sell fixtures
measure 738/696 bytes, including both 64-byte signatures, below the 1,232-byte
runtime limit. The SDK reserves both signatures when enforcing that limit.

## Source and verification

The fixed deployment is exported from [src/config/aeth-usd.ts](src/config/aeth-usd.ts):
aETH `AzuWEhnYUv6NTAFrC2MtzKb4nASh6sCMcD15WUmoFR45` and
aUSD `DQcBfwHu8gr8KGt3BE5BDUfBjGgFuDJYm9ByVTDsrww9`. Other identities and
signer roles are pinned there. A signer/deployment change requires reviewing
these pins; this path does not perform discovery.

Fixtures and the HTTP/layout mappings above use PropAMM `minting` revision
[`dfdbc9a36646066cbec067fa9e9a700232804855`](https://github.com/Arch-Network/prop-amm/commit/dfdbc9a36646066cbec067fa9e9a700232804855).
The earlier live inspection matched this minting behavior, but health did not
expose `build_sha`; the exact deployed revision remains unverified. SDK-6 does
not revalidate the live server or submit a mainnet swap.

[Test coverage](tests/README.md#aethausd-direct-rfq-coverage) and
[native fixture provenance](tests/fixtures/aeth-usd/README.md) identify the
checks for message preservation, creation accounts, integer precision, expiry,
signed-size enforcement and the existing BTC/USD, vault, CLAMM and router RFQ
regressions. Run from this checkout:

```sh
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Final SDK verification on 2026-10-28:

| Check | Result |
| --- | --- |
| `corepack pnpm test` | 698 tests passed across 14 files, including 48 direct client tests. |
| `corepack pnpm typecheck` | Passed, including public consumer type assertions. |
| `corepack pnpm build` | Passed; ESM and declarations emitted. |
| Built ESM entry point smoke check | Both direct directions dispatched to the mock provider; errors preserved and no account reads. |
| `git diff --check` and local documentation links | Passed. |

The usage-example verification on 2026-10-28 added 40 mocked execution tests;
the full suite now passes 738 tests across 15 files. Typecheck (including
`examples/**/*.ts`), build and documentation link checks also passed. Both
directions preserve the message through HTTP decoding, wallet signing and
submission; retry tests verify the identical cached body and known-hash
confirmation without re-submission. The example's response decoder rejects
unsafe numeric metadata; larger output/expiry values require a lossless adapter.

The SDK checkout is on `aeth-mint`, based on `467ef98`. SDK-4 through SDK-6 and
the usage-example changes are uncommitted at handoff. The package remains private;
no publication or deployment is included. Live missing-account creation,
deployment coordination, packaging and funded smoke tests remain rollout work.
