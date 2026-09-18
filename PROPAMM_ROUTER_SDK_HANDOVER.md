# PropAMM integration into the router TypeScript SDK

Handover prepared on 2026-09-18. Target repository:
`~/Arch/arch-swap-router-ts-sdk`.

Implement this in the SDK. Keep the changes small and straightforward: reuse
the fixed routes, vault math, instruction builder, and existing Arch SDK helpers.
This document is the implementation handover; no SDK implementation has been
made during this conversation.

## Confirmed scope

- **Testnet first.** Do not enable PropAMM routing on mainnet or replace its
  placeholder deployments as part of this work.
- Add PropAMM to **`quoteExactIn` only**. Leave `quoteForOutput` behavior unchanged
  and do not call the RFQ provider from its local input-sizing search.
- Support both directions of all four swap shapes: swap, redeem/swap,
  swap/mint, and redeem/swap/mint. Direct vault mint/redeem stays unchanged.
- Return **one winning `SwapQuote`**, preserving the existing public methods.
- Compare the **final estimated output after venue fees**, including any vault
  prefix/suffix. Higher output wins; **CLAMM wins ties**. Do not convert ARCH
  transaction fees into token value for ranking.
- Use the Rust router's **`propamm` branch** and PropAMM's
  **`router-rfq-signing` branch** as the integration contracts.

Do not add graph discovery, split routes, a generic adapter framework, route-list
APIs, background refresh, automatic retries, wallet management, or an execution
service. No dependency upgrade is required for this feature.

## Source checkouts and starting state

These were the inspected revisions; check current state before starting and
preserve any subsequent user changes.

| Repository | Branch / revision | Relevant sources |
| --- | --- | --- |
| `~/Arch/arch-swap-router-ts-sdk` | `main`, `237409b` | `src/client.ts`, `src/types.ts`, `src/config/routes.ts`, `src/transactions/`, `src/codecs/` |
| `~/Arch/arch-swap-router` | `propamm`, `63c37f5` | `src/instruction.rs`, `src/adapters/prop_amm.rs`, `src/utils/prop_amm.rs`, `arch-swap-router-propamm-design.md` |
| `~/Arch/prop-amm-router-signing` | `router-rfq-signing`, `a7ccb99` | `server/src/routes/rfq.rs`, `server/src/routes/quote.rs`, `server/src/router_transaction.rs`, `server/src/rfq.rs` |
| `~/Arch/prop-amm` | Native ABI referenced at `734a906` | `program/src/instruction.rs`, `program/src/execute_trade.rs`, `deployment-configs/testnet.toml` |

The SDK checkout was clean but one commit behind its locally known `origin/main`
(`a657147`, dummy mainnet configuration). Account for that change when choosing
the implementation base; do not overwrite it or treat dummy IDs as deployments.

The current `~/Arch/prop-amm` working tree also contains separate, uncommitted
minimal-follow-up E2E changes. Do not modify, revert, or include those changes in
the SDK work. That checkout does not yet contain the router-signing server code;
read the **separate signing worktree** listed above.

The SDK's older `SIMPLIFICATION_PLAN.md` deliberately deferred PropAMM and
transaction-size checks. This handover adds the narrowly scoped PropAMM work.
The Rust design discusses receive-side RFQ sizing too; that part is explicitly
deferred by the user's latest decision.

## Testnet deployment

Use the SDK's existing testnet router, vault, CLAMM, prime-token, token-program,
and ATA-program configuration. The following PropAMM identities were verified
against the deployment config and public `/health` and `/markets` responses:

| Setting | Value |
| --- | --- |
| Server base URL | `http://64.34.82.201:3000` |
| PropAMM program | `9EqAsENtgBA4Uo4wbS8LVdaQJjMKPpagMxgDVhxEWtKq` |
| Quote signer / maker | `FosDeThFmSTGcaQxgyhaPWhBrnEovCJ7jHzTcwp1dmYi` |
| Config PDA | `3ak4e8ZxNVYfKw8hapDvRGPKtPBSrqBYomKSQ3XMWGxM` |
| Base mint: aBTC, 8 decimals | `2yHWVNYyjnsxZqpnvTbPzWiHwpNQ2zBQU6BC4Lnbu7sW` |
| Quote mint: aUSD, 6 decimals | `6mqUuwPYehXei6mGBY4bQ6XK1z7e6rrFAZRzYKdH8qkp` |
| Configured quote TTL | 30,000 ms; always honor each returned quote's expiry |

Derive vault and nonce addresses with the existing PDA helper and native seeds:

```text
config:     ["config", maker]
base vault: ["vault", base mint, maker]
quote vault:["vault", quote mint, maker]
user nonce: ["user_nonce", config, user]
```

The live server reported build `734a906` when inspected, before router signing
was added. The signing branch enables testnet via `[server.router]`. Offline
SDK implementation can proceed, but a live test requires deploying compatible
router/server versions and verifying their identities. Source availability is
not evidence that those versions are deployed. No deployment is part of this
handover task.

## Small implementation shape

The names below are suggestions, not a requirement to introduce abstractions.

1. Add one optional injected `PropAmmQuoteProvider` to `RouterClientOptions`.
   Without it, existing quote behavior and read budgets should remain unchanged.
   Keep HTTP/proxy configuration with the consuming application, as account
   transport already is. Do not add a mandatory fetch client or new dependency.
2. Add one small `src/propamm.ts` module for RFQ result validation, native term
   handling, and PropAMM account resolution. Reuse existing address/PDA helpers.
3. Add an optional testnet PropAMM deployment entry to the network config. Avoid
   adding a required property that forces invented mainnet addresses.
4. Extend the existing step unions, encoder, and builder for `propamm`.
5. In `client.ts`, evaluate at most two candidates at the existing CLAMM position.
   Keep the same 12 supported mint pairs and the same fixed paths. Do not duplicate
   public pair entries just because there are two swap venues.
6. Add a small optional submission marker to `SwapQuote`, for example
   `rfq?: { quoteId: string }`, present only for a PropAMM winner. The existing
   `instructions` and `deadlineMs` carry the executable bundle and effective
   expiry. The application already knows the selected network/provider.

Suggested provider boundary:

```ts
interface PropAmmQuoteProvider {
  quoteExactIn(request: {
    inputMint: Address;
    outputMint: Address;
    amountIn: bigint;
    user: Address;
  }): Promise<PropAmmQuote>;
}

interface PropAmmQuote {
  quoteId: string;
  terms: {
    side: "buy" | "sell";
    baseAmount: bigint;
    quoteAmount: bigint;
    expiryMs: bigint;
    nonce: bigint;
  };
  estimatedAmountOut: bigint;
}
```

Keep RFQ waiting bounded by a short, documented timeout so an unavailable server
cannot indefinitely hold up a valid CLAMM result. A simple per-call timeout is
enough; avoid retry/circuit-breaker infrastructure. Settle failures independently
and clean up timers/cancellation when applicable.

## Quote evaluation

For a route containing a swap:

1. Load and prepare any shared vault prefix/suffix once using existing code.
2. Estimate the redemption prefix, if present. Its estimated net output is the
   input to **both** swap candidates. Without a prefix, use `request.amountIn`.
3. Independently estimate CLAMM and request **one** PropAMM RFQ for that input.
   Do not force the PropAMM candidate through CLAMM account/tick validation.
4. For PropAMM, verify direction, positive u64 amounts, nonempty quote ID, valid
   expiry, and that quoted input equals the requested intermediate input.
   Buy input is `quoteAmount`; Sell input is `baseAmount`.
5. Feed each swap's estimated output through the shared mint suffix, if any.
   For PropAMM use `estimatedAmountOut`, not the nominal compact-quote output:
   the server estimate already includes inventory skew.
6. Apply user slippage once to the **final** output, using existing rounding and
   the positive-minimum requirement. Do not add a separate hop slippage floor.
7. Build/check the PropAMM candidate's actual instruction bundle and signed size
   before selecting it. An expired, malformed, or oversized candidate is invalid.
8. Select the higher final output, preferring CLAMM on equality. Return its
   instructions and, only for PropAMM, its RFQ submission marker.

A PropAMM decline/timeout must not hide a valid CLAMM candidate. A CLAMM-specific
failure must not hide a valid PropAMM candidate. Failure of a required shared
vault invalidates both. If neither candidate is usable, reject with a meaningful
existing-style `RouterSdkError`; there is no need for a public failure-report API.

For a PropAMM candidate use:

```text
effective deadline = min(request.deadlineMs, terms.expiryMs)
```

Recheck that it is still in the future before returning/selecting it. Keep u64
terms as `bigint`; only convert the effective deadline to `number` after proving
it fits the SDK's existing safe-integer contract. CLAMM deadlines stay unchanged.

Actual redemption output can differ at execution. The router passes the entire
measured output to PropAMM, whose accepted input interval is
`ceil(quotedInput * 9950 / 10000) .. quotedInput`. Preserve that behavior: no
padding the RFQ input, capping actual input, resizing original terms, or consuming
pre-existing intermediate balances. An out-of-range execution fails atomically;
the SDK must not promise otherwise or attempt a fallback after signing.

## RFQ HTTP contract and application handoff

The provider maps its normalized request to `POST /rfq/quote`:

```text
base_mint: aBTC public key encoded as hex
quote_mint: aUSD public key encoded as hex
side: "sell" for aBTC -> aUSD; "buy" for aUSD -> aBTC
amount: the swap-leg input in raw units
user_pubkey: user's public key encoded as hex
```

The signing branch returns a flat unsigned `RuntimeTransaction`, `quote_id`,
and `estimated_quote`. Recover original terms from the returned native trade
instruction, and obtain the adjusted output from `estimated_quote.base_amount`
for Buy or `estimated_quote.quote_amount` for Sell. The HTTP adapter must verify
the returned instruction's program, user, and mint identities against the request
and deployment when normalizing the response.

**Preserve integer precision at this boundary.** The Rust HTTP API uses JSON
numeric u64 fields; ordinary `response.json()` can round large integers. Use
lossless handling in the application provider or reject unsafe numeric values.
Do not silently cast arbitrary `bigint` amounts to `number`. Decode compact term
bytes with `DataView.getBigUint64(..., true)` where available.

For the winner, the application compiles the SDK-returned instructions with the
user as fee payer and a recent blockhash, obtains the user signature, and sends:

```text
POST /rfq/swap
{ quote_id, version: 0, signatures: [userSignature], message: routerMessage }
```

The server validates the complete router message, adds the maker signature,
submits it, and returns `{ transaction_hash }`. The SDK does not sign or submit.
It must preserve the server's original compact terms; the direct RFQ message is
not reused as the outer router message.

Once a validated submission binds a quote to a message, retry only that same
message. Changing the blockhash or route requires a fresh quote. Document this
for callers; do not add SDK retries or refresh logic. The standalone swap-test
`skip_account_creation` option is unrelated to this router integration.

## Encoding and account contract

Keep the existing 26-byte `RouteExactInV1` header, tags 0/1/2, maximum three hops,
and final output minimum. Add the Rust router's **step tag 3**, exactly 34 bytes:

```text
tag:u8 = 3
side:u8 = 0 (Buy) or 1 (Sell)
quoted_base_amount:u64 LE
quoted_quote_amount:u64 LE
expiry_ms:u64 LE
nonce:u64 LE
```

There is no `amount_in` or `min_out` field in the router step. At execution the
router constructs the native 50-byte ExecuteTrade CPI using measured input and
explicit native `min_out = 0`; the router enforces the final minimum. Do not
confuse the 34-byte router step with the 42/50-byte standalone PropAMM payload.

Reuse the current common route accounts: writable signing user, token program,
then mint/user-ATA pairs. Mint writability still follows existing vault rules.
The PropAMM venue group has exactly seven positional accounts:

| Position | Account | Privilege |
| --- | --- | --- |
| 0 | PropAMM program | Read-only |
| 1 | Config PDA | Read-only |
| 2 | Quote signer / maker | **Read-only signer** |
| 3 | User nonce PDA | Writable |
| 4 | Base vault | Writable |
| 5 | Quote vault | Writable |
| 6 | System Program | Read-only |

The resulting message has exactly two signers: writable user/payer, followed by
read-only maker. Do not accidentally promote the maker to writable or include it
in vault account groups. Preserve positional duplicate accounts where required;
the Arch message compiler deduplicates public keys.

Keep System in the PropAMM venue group: the **router ABI requires it**, even when
the nonce exists. Standalone PropAMM's optional-System optimization does not
change this router contract. The router creates user ATAs through its existing
ATA/System trailer; the PropAMM CPI omits its own ATA program.

## Compute layout and size: important integration details

The current TS SDK returns one router instruction. The native multi-hop PropAMM
execution fixtures use **two outer instructions**: an idempotent input-ATA
instruction, then the router with its ATA/System trailer. In that tested runtime
this supplies the normal 400,000 CU allowance; the three-hop case measured up to
323,559 execution CU. One outer instruction is not proven sufficient for it.

For the initial PropAMM bundles, use that existing tested two-instruction layout
for all four shapes. This keeps one construction path and matches the fixtures.
Keep unrelated CLAMM/vault bundles unchanged. The input-ATA instruction
must match the canonical instruction accepted by
`prop-amm-router-signing/server/src/router_transaction.rs`. Do not substitute
an arbitrary compute-budget instruction: that server does not accept one.
Further instruction-count/compute optimizations are outside this change.

Measure the actual compiled PropAMM bundle including **both 64-byte signatures**
against the **1,232-byte** limit. Reuse the installed Arch SDK's
`SanitizedMessageUtil.createSanitizedMessage` and `TransactionUtil` serialization
or size helper; a zero blockhash and placeholder signatures are sufficient for
offline size calculation only. Never return those placeholders for submission.

The native three-hop two-instruction fixture is 1,225 bytes with shared fee
destinations. Different fee accounts can exceed the limit. Do not hardcode those
fixture totals as universally applicable, change fee recipients, or remove
required accounts to force a fit. Reject that PropAMM candidate and retain a
valid CLAMM alternative. Callers must recheck size if they alter the bundle.

## Files likely to change

| SDK file | Minimal change |
| --- | --- |
| `src/types.ts`, `src/index.ts` | Optional provider, normalized RFQ types, optional selected-quote marker |
| `src/config/networks.ts` | Optional testnet-only PropAMM identities |
| `src/propamm.ts` (new) | Small RFQ validation/account-resolution helper |
| `src/client.ts` | Shared vault preparation and at most two exact-input candidates |
| `src/codecs/types.ts`, `src/codecs/instruction.ts` | Native tag-3 compact step |
| `src/transactions/types.ts`, `src/transactions/instructions.ts` | Seven-account group and RFQ terms; small bundle/size helper if needed |
| `tests/`, `README.md` | Focused fixtures, selection tests, and provider/submission documentation |

Avoid rewriting `vault.ts`, `clamm.ts`, or the fixed route registry. If extracting
shared preparation is necessary, keep it small and private. Do not mirror the
PropAMM pricing engine in TypeScript; the provider supplies its execution estimate.

## Verification and completion

Use existing checked-in native evidence rather than deriving expected values
from the new TypeScript implementation:

- `arch-swap-router/tests/fixtures/prop_amm/{accounts,trades}.json`: native PDAs,
  config, and ExecuteTrade terms/account ordering.
- `arch-swap-router/src/instruction.rs` and its existing instruction fixtures:
  compact router step and framing.
- `prop-amm-router-signing/server/tests/fixtures/router-transactions.json` and
  its README: eight signed Rust runtime fixtures, both directions of all four
  shapes, including exact signer permissions and two-instruction layouts.
- Existing SDK vault/CLAMM fixtures: shared prefix/suffix math and regression
  checks for all 12 pairs.

Copy only the necessary fixture data/provenance into the SDK. No production or
test dependency on sibling filesystem checkouts should be introduced.

Focused acceptance cases:

- CLAMM wins, PropAMM wins, and CLAMM wins a tie **after the suffix**.
- Both directions of all four PropAMM shapes; correct prefix amount sent once to
  the RFQ provider and final-only slippage.
- PropAMM timeout/decline/malformed/expired quote leaves CLAMM available;
  CLAMM-specific failure leaves PropAMM available; shared-vault failure rejects.
- Exact original nominal terms, maker privileges, native accounts/bytes, fresh
  effective deadline, and correct winner-only `quote_id` metadata.
- Full compiled two-signature size, including an oversized candidate and the
  accepted multi-hop outer instruction layout.
- No provider calls for `quoteForOutput`, direct mint/redeem, mainnet,
  or invalid/unsupported requests. Existing behavior without a provider remains.
- u64 precision above `Number.MAX_SAFE_INTEGER`, zero/invalid amounts, invalid
  side/input binding, and expired deadlines.

Run from the SDK directory:

```sh
pnpm typecheck
pnpm build
pnpm test
```

Inspect generated public declarations and update the README with a short
injected-provider example and the PropAMM submission handoff. Report offline
verification separately from any live test. Live execution is a later step after
the compatible router and signing server are deployed; do not publish, deploy,
or send funded transactions merely to finish the SDK changes.
