# Tests

Run all current checks from the SDK root:

```sh
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

## Native swap adapter

`native-swap-client.test.ts`, `native-swap-transaction.test.ts`, and
`examples/native-swap.test.ts` cover request/response mapping, full-u64 amounts,
discovery, slippage forwarding, cancellation, native packet decoding,
user/treasury signer slots, private message snapshots, expiry around wallet
signing, submission uncertainty, and explicit attempt recovery without retries.

Five packets were exported from the actual PropAMM native HTTP quote handler at
revision 6fb6483 using loopback RPC/pricing fixtures. Tests compare both the
message and the complete unsigned transaction against Rust-generated hex. See
[fixture provenance and regeneration](fixtures/native-swap/README.md).
Wallet signatures in TypeScript tests are synthetic. No production quote,
funded transaction, or live submission is required.

## Limit orders and shared account utilities

`limit-orders.test.ts` retains the native instruction/account bytes, account
ordering and privileges, PDA/ATA derivations, create/cancel builders, limit-price
math, previews, and account-loading checks for both networks. Instructions are
compiled with the Arch SDK to verify the owner remains the fee payer and only
user signer. Rust-ordered message compilation is no longer an SDK feature.

See [native order fixtures](fixtures/limit-orders/README.md) for their generator,
IDL snapshot, account layouts, and math provenance. `accounts.test.ts` preserves
address validation and the account reader's order, deduplication,
absence, malformed-response, and transport-error behavior.

`tests/types` checks both public lifecycles at compile time. Type checking also
covers the application signing example. Legacy routing/quote suites, live
router smoke tests, and their obsolete fixtures have been removed with the old
implementation.

The final suite passes 232 offline tests: 138 adapter/example checks, all 72
order regressions, and 22 retained account-reader/address checks. Type checking
and the clean production build pass. No live tests run in this suite.

## Package verification

Build from a clean output directory before packing. Inspect the archive and its
root exports for stale router clients, quote math, instruction builders, or
configuration. This verification does not publish the package. The retained
`RouterSdkError` and `RouterDataSource` names are order API compatibility only.

Quote handoff coverage also exercises serialized restoration on a new client,
service isolation, injected clocks, signature exclusion and consumed-quote conflicts.
