# Router SDK implementation handover

Start with [SIMPLIFICATION_PLAN.md](SIMPLIFICATION_PLAN.md) for the agreed scope
and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for checkpoints and evidence.
The older graph/ranking design has been replaced by explicit fixed routes.

## Current state

Checkpoint 3 is complete. The public surface is
`createRouterClient({ source }).quoteExactIn(request)`, plus mint constants,
`SUPPORTED_PAIRS`, errors, and the small request/result/reader types.
The fixed testnet registry contains all 12 directed pairs among aBTC, aUSD,
primeBTC, and primeUSD.

Supported quote calls still throw `NOT_IMPLEMENTED`; unsupported/identical pairs
throw `UNSUPPORTED_PAIR`. No account reads or quote calculations happen yet.
The next task is checkpoint 4: validation, batched account reads, and direct vault
Mint/Redeem estimates.

Router encoding, result framing, PDA/ATA derivation, and instruction construction
work against fixtures. The builder takes one set of resolved step addresses and
constructs account order/privileges itself. Fixed-route topology is checked in
tests. The builder and byte decoder remain internal.

## Frontend contract

Requests contain input/output mint addresses, raw `bigint` input, slippage BPS,
wallet address, and an absolute millisecond deadline. The eventual result is one
flat `SwapQuote`: input/output mints, input amount, estimated output, final
minimum, instructions, and deadline. See [public types](src/types.ts).

The SDK returns only the router instruction, retaining its ATA/system trailer.
The router creates missing input/intermediate/output ATAs internally. There is
no extra top-level ATA creation or compute-budget instruction. Compute provisioning
is separate router/runtime work: the runtime establishes the transaction budget
before execution, and removing the old extra instruction reduces the default
allowance. This SDK change does not establish sufficient compute for live routes.

The application owns refresh, blockhashes, final transaction sizing/compilation,
signing, deadline checks around signing, submission, confirmation, and retries.
There are no quote timestamps, candidate lists, configurable venues, or execution
preflight. Preserve the current native ABI and independent fixture expectations.

## Next implementation details

Use the existing injected `RouterDataSource.getAccounts(addresses)`. Results
preserve input order and use `AccountInfoResult` directly: `data` and `owner`
are `Uint8Array`, with `lamports`, `utxo`, and `is_executable` unchanged.
The application adapter normalizes RPC/indexer number arrays. Only confirmed
absence becomes `null`; an indexer miss or transport error is not proof of
absence. Reject malformed responses and transport failures.

Fetch calculation inputs only, deduplicating within each request. Direct vault
quotes target one batch; CLAMM-containing routes target at most two shared
batches, loading pool state before the selected tick arrays. Construction does
not read again. Each public call starts fresh. Physical HTTP counts depend on
the app reader/provider, and batched reads do not guarantee an atomic snapshot.

For vaults, port the necessary decoder/APL readers and pure previews from
`../arch-vaults/clients/ts/vault-rpc-client/src`; pin provenance and reuse
`../arch-vaults/fixtures/client-contract.json`. Apply management-fee share
accrual before conversion and capture one internal evaluation time for fee/NAV
checks. Retain native fees, virtual offsets, decimals, rounding, caps, pauses,
and freshness. This internal clock is not part of the returned quote.

Immediate Redeem needs an empty observed queue, gross reserve coverage, fresh
NAV for the immediate payout, and positive net output. Derive the entry from the
observed tail. Do not fetch fee/escrow/entry accounts just to check readiness.
Concurrent state can change; native immediate-fill-or-abort support remains
separate work. Do not invent an ABI flag or offer queued redemption as a swap.

Later, port only CLAMM readers, tick selection, and exact-input math from
`../arch-swap/src/lib/clamm`. Use three primary positions, zero supplements,
native boundary repetition/absent-tick handling, and the quote-window price
limit. Require full input consumption. Feed each estimated net output through
the selected fixed route, with zero per-hop slippage. Apply slippage once to the
final output and require a positive minimum.

## Dependencies and verification

Reuse the pinned Arch SDK for instructions, PDA/ATA derivation, and integer
helpers. Use `@scure/base` for base58. No sibling filesystem dependencies,
frontend aliases, extra transport, or generic venue plugin framework belong in
the package. Browser verification must exercise the actual PDA path; Arch SDK
0.0.28 requires a small explicit Buffer compatibility setup.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

All 150 current tests, typecheck, build, and a separate strict check of the test
files passed at checkpoint 3. The 18 original transaction fixtures are intact;
tests now compare only their router instruction. Size expectations remain
historical fixture metadata, not SDK policy. See [test coverage](tests/README.md)
and [fixture provenance](tests/fixtures/transactions/README.md).
No live transactions or browser verification were performed in this checkpoint.
