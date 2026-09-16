# Router SDK implementation handover

Start in `C:/Users/spaceman/arch-swap-router-ts-sdk`. This document records the
agreed scope and the shortest implementation path for frontend integration.
Read it with [the current types](src/types.ts) and
[the full design](../arch-swap-router/arch-swap-router-sdk-plan.md).
Current Rust source and fixtures are authoritative for the program ABI.

## Goal and current state

Implement a small browser-compatible SDK that discovers configured routes,
quotes them once, and returns a capped list ranked by final output. Every result
contains ready-to-use instructions. Keep the frontend integration to one quote
call, selection of one result, and the application's existing signing flow.

The project is a scaffold. The client factory, types, testnet registry, package
configuration, and errors exist. Quoting, discovery, account reads, venue adapters,
codecs, and instruction construction still throw `NotImplementedError`. Internal
PDA/ATA helpers now delegate to the Arch SDK, with base58 conversion and
32-byte address validation.
Do not interpret successful builds as working quotes or verified live routes.

- Package: `@arch-network/swap-router-sdk`, private until publication is requested.
- Base dependency: `@arch-network/arch-sdk@0.0.28`; use the lockfile.
- TypeScript 5.9.3, ESM with declarations, pnpm 10.12.4, Vitest 3.2.4.
- Node 20.19+ in the 20.x line, or Node 22.12+.
- Typecheck/build and PDA/ATA compatibility tests pass. The fixtures are copied
  from the Rust router's account-validation tests; quote behavior remains untested.
- At handover, this directory has no Git metadata. Do not assume a remote or
  publishing/deployment setup exists.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

On the previous Windows agent, Node/pnpm were absent from PATH. The available
Node was `C:/Users/spaceman/AppData/Local/Programs/cursor/resources/app/resources/helpers/node.exe`.
A temporary pnpm CLI was at
`../arch-swap-router/target/sdk-bootstrap/package/bin/pnpm.cjs`.
These are host-specific fallbacks, not package dependencies or portable paths.
Prefer the normal installed toolchain when available.

## Locked public contract

`createRouterClient({ deployment, venues, source })` returns a client with only
one public swap method:

```ts
quoteRoutesExactIn({
  inputMint,       // Base58 mint.
  outputMint,      // Base58 mint.
  amountIn,        // bigint, raw input units.
  slippageBps,     // Caller choice; integer 0..9999.
  user,           // Base58 Arch/x-only wallet public key.
  deadlineMs,     // Caller choice; absolute Unix milliseconds.
  limit,          // Optional positive integer; default 3.
}): Promise<{
  quotedAtUnixSeconds: number;
  quotes: readonly {
    quote: RouteQuote;
    instructions: readonly Instruction[];
    deadlineMs: number;
    expectedSignedSize: number;
  }[];
  unavailable: readonly RouteFailure[];
}>;
```

The timestamp describes response generation, not a chain snapshot or expiry.
Use `bigint` throughout amount/price math. Convert the safe-integer millisecond
deadline to the router's `u64` wire field without changing its value.

The caller owns quote refresh, deadline selection, blockhash acquisition,
transaction compilation, signing, submission, confirmation, and retries.
There is no automatic refresh, TTL, deadline extension, RPC polling, route
substitution, or quote server in this SDK.

Do not add public `findRoutes`, `quoteRouteExactIn`, or `buildSwap` methods.
A quote already includes its instructions. Keep internal helpers private and
avoid creating wrappers or classes that only forward calls.

V1 supports Mint, Redeem, and CLAMM exact-input routes with one to three hops.
PropAMM, exact-output, split routes, cycles, residual handling, mainnet presets,
React hooks, and frontend migration are deferred.

## Reuse the Arch SDK

The user explicitly selected `@arch-network/arch-sdk` and lightweight reuse.
Do not restore the Saturn dependency or build a second Arch client/serializer.
The following exports were inspected in the installed 0.0.28 declarations and
implementation:

| Need | Reuse |
| --- | --- |
| Account reads | `AccountInfoResult`; optionally `RpcConnection.readAccountInfo` or `getMultipleAccounts` in an application adapter. |
| Account metas and instructions | `AccountMeta`, `Instruction`, and `Pubkey` from the Arch SDK. |
| Message and transaction representations | `SanitizedMessage`, `RuntimeTransaction`, and `ProcessedTransaction`. |
| PDA derivation | `PubkeyUtil.findProgramAddress(seeds, programId)`. Supply the venue's seeds; do not reproduce hashing or curve checks. |
| Canonical user ATAs | `PubkeyUtil.getAssociatedTokenAddress(mint, owner, true, tokenProgram, ataProgram)`. The explicit `true` permits Arch's 32-byte x-only keys under this helper's curve guard; covered by Rust ATA fixtures. |
| Message compilation | `SanitizedMessageUtil.createSanitizedMessage`. It returns a compile-error string on failure; handle it. |
| Full transaction size | `TransactionUtil.serializedSize` and `checkTxSizeLimit`; use `RUNTIME_TX_VERSION` and `RUNTIME_TX_SIZE_LIMIT`. |
| RPC array representation | `TransactionUtil.toNumberArray` in the application transaction flow. |
| Shared program identities | SDK `TOKEN_PROGRAM_ID`, `ASSOCIATED_TOKEN_PROGRAM_ID`, and `SYSTEM_PROGRAM_ID` for byte-level helpers. They match the router's testnet constants. |
| Existing integer helpers | `SystemInstruction.u32ToLeBytes` and `u64ToLeBytes` where suitable; use `DataView` for the small remaining router-specific fields. |

The public deployment registry keeps readable base58 strings. Decode at the
boundary and use SDK `Pubkey` bytes internally. SDK 0.0.28 does not export a
base58 codec. The direct `@scure/base@1.2.6` dependency supplies that codec,
reusing the version already in the Arch SDK's dependency tree. Do not copy the
frontend's handwritten base58 algorithm or rely on an undeclared transitive import.
`src/accounts/address.ts` validates decoded keys; `src/accounts/pda.ts` delegates
PDA and ATA derivation. These are internal helpers, not new public API methods.

The SDK's PDA/hex helpers use `Buffer` internally. Exercise the actual PDA path in
a browser build before claiming frontend readiness. If necessary, provide a
small explicit Buffer compatibility setup in the integration example, or use a
compatible upstream fix. Do not add a broad Node polyfill bundle or duplicate
cryptography to hide this dependency behavior.

Router instruction encoding, venue state decoding, and quote math are
program-specific and are not supplied by the base SDK. Those are the justified
custom parts. Reuse existing venue helpers before writing replacements.

## Account source: use the RPC type directly

The user confirmed `AccountInfoResult`, not the SDK's instruction-oriented
`AccountInfo`. The custom `AccountSnapshot` interface has been removed.

```ts
import type { AccountInfoResult } from "@arch-network/arch-sdk";

interface RouterDataSource {
  getAccounts(
    addresses: readonly Address[],
  ): Promise<readonly (AccountInfoResult | null)[]>;
}
```

`AccountInfoResult` supplies `lamports`, `owner: Pubkey`, `data: Uint8Array`,
`utxo: string`, and `is_executable`. Read those fields directly; do not rename
them to `executable` or turn `owner` into a base58 string in a second DTO.
The root package also re-exports this existing type for convenience.

Keep the one injected account reader so the frontend can reuse its indexer.
Results preserve input order. A missing account is `null`; transport failures
remain errors. The SDK's batch method returns `AccountInfoWithPubkey`, which is
structurally compatible with `AccountInfoResult` and adds `key`.

Inspect actual reader output at the integration boundary: in 0.0.28,
`readAccountInfo` normalizes byte arrays while `getMultipleAccounts` returns the
RPC result directly. The frontend reader also currently returns number arrays.
Normalize `data` and `owner` to `Uint8Array` once in that adapter when necessary,
without introducing another account model. An indexer cache miss is not proof of
on-chain absence; resolve that in the application reader instead of classifying
RPC errors or unindexed state as empty venue accounts.

Avoid another transport class, HTTP client, or mandatory direct-RPC dependency.
Use only a request-local read map if it avoids repeated pool/vault fetches.

## Minimal implementation sequence

1. **Thin SDK integration and router codec.** Byte conversion and SDK PDA/ATA
   delegation are implemented and checked against fixtures. Encode the existing
   router instruction, resolve account order,
   build ATA/router instructions, and measure size using SDK utilities. Add
   independent Rust-derived fixtures before expanding the quote engine.
2. **Direct vault routes.** Reuse vault decoding and pure preview functions.
   Implement Mint first, then immediate Redeem. Keep account checks next to the
   relevant adapter. Return real quotes and instruction bundles through the one
   public method.
3. **CLAMM and the route graph.** Port the needed CLAMM state/math helpers, then
   enumerate simple paths over configured venues, retaining parallel venue edges.
   Start with the four-token registry; use no hardcoded pair-to-route table.
4. **Composition and ranking.** Feed each estimated net hop output into the next
   quote, build each viable candidate, sort, and cap. A failure in one candidate
   must not hide other candidates.
5. **Frontend example and verification.** Demonstrate one quote call and the
   existing application transaction flow. Add package/browser checks and opt-in
   testnet smoke coverage, beginning with direct routes.

Use small functions and the existing modules. A future adapter extension does
not require a plugin framework, route service, dependency-injection container,
persistent cache, or a new package for every venue. Simplify the scaffold when
a file or interface adds no useful boundary.

For discovery, a bounded depth-first traversal is sufficient: unique mints,
one to three hops, distinct edges by venue ID and operation. For this registry,
quote all candidates before applying the cap; do not return the first discovered
paths or assume the path with fewer hops has the best output.

Rank by estimated final output descending, then hop count ascending, then stable
route ID. Return up to `limit` successful, buildable quotes. Failed candidates
carry a quote/build stage and reason in `unavailable`; successful candidates
outside the cap are not failures. An empty successful list is valid. Reject
malformed requests/configuration and request-wide transport failures explicitly.

## Venue implementation sources and constraints

- Vault source: `../arch-vaults/clients/ts/vault-rpc-client/src`. Reuse
  `decodeVault`, the APL readers in `apl.ts`, and the pure functions in
  `preview.ts`. Include `previewManagementFee` before Mint/Redeem conversion;
  the simple preview helpers do not apply accrued fee shares automatically.
  Preserve native fees, virtual offsets, rounding, caps, pauses, and applicable
  NAV freshness checks. Read share decimals.
- Redeem requires an empty observed queue, full gross reserve coverage, and
  positive immediate output. Derive the entry using that snapshot's queue tail.
  The native immediate-fill-or-abort ABI is still pending: client prechecks
  cannot enforce that guarantee against concurrent state changes. Do not append
  an invented flag or offer queued redemption as a swap fallback.
- CLAMM source: `../arch-swap/src/lib/clamm`, especially `state.ts`,
  `pda.ts`, and `math/swap-math.ts`. Use `swapQuoteByInputToken` and its
  dependencies. Keep native fee/rounding and tick traversal behavior. Begin with
  three primary tick arrays, zero supplements, and a quote-window price limit;
  reject windows that cannot consume the full input.
- Port only the necessary pure functions and their fixtures; record source
  revisions. Replace frontend aliases and SDK imports. Avoid importing the
  complete frontend or its finished direct-CLAMM transaction builder, which
  adds a different account/ATA/supplement layout.
- The vault TS package is currently private, and frontend deployment wrappers
  target different vault IDs. Use the SDK testnet registry and explicit program
  IDs. A small vendored subset is acceptable until compatible packages exist;
  do not leave sibling filesystem dependencies in the packed SDK.
- Future PropAMM will be another graph connection with an asynchronous quote
  provider. Its existing server-signed transaction cannot be assumed composable
  inside a router instruction. Leave that implementation and signing flow deferred.

Apply slippage only once:
`estimatedFinalOut * (10_000n - BigInt(slippageBps)) / 10_000n`, requiring a
positive result. On-chain execution consumes the preceding hop's actual credit;
the SDK's intermediate quantities are estimates, not separately encoded amounts.

## On-chain construction facts

Read the [frontend handover](../arch-swap-router/arch-swap-router-frontend-handover.md)
for complete account tables and identities, and compare with current source:

- Instruction: tag 0, input `u64`, final minimum `u64`, deadline-ms `u64`,
  step count `u8`, then step bytes. No Anchor discriminator or Borsh vector
  length. Mint/Redeem tags are 0/1; CLAMM tag 2 carries direction, `u128` price
  limit, and supplemental count.
- Prefix: user, token program, then every mint/user-ATA pair. Venue groups follow:
  Mint has 6 accounts, Redeem 9, CLAMM 8 plus supplements. Append ATA/system
  accounts. Preserve duplicate venue positions while message compilation merges
  account keys and privileges.
- Prepend the idempotent input-ATA instruction, then the router instruction.
  The router creates missing intermediate/output ATAs internally. Match the Rust
  E2E layout; do not append an explicit compute-budget instruction by default.
- Measure a local `RuntimeTransaction` using a dummy 32-byte blockhash and
  one dummy 64-byte signature for each required signer. Use SDK compilation,
  `TransactionUtil.serializedSize`, and `checkTxSizeLimit`. Neither the dummy
  transaction nor blockhash is returned. Callers adding instructions/signers must
  recheck the complete transaction.
- Current signed-size limit: SDK `RUNTIME_TX_SIZE_LIMIT` (1,232 bytes).
  Rust three-hop fixtures accept 1,211 bytes with shared fee destinations and
  reject 1,275 bytes with distinct destinations. No splitting or removing required
  accounts to make a route fit.
- Success result: exactly 17 bytes, version 1 plus measured input/output `u64`.
  Require successful status, no rollback, and the router's program identity.
  Native errors can share numeric codes with router errors; preserve attribution.

Useful source and fixtures:
[wire types](../arch-swap-router/src/instruction.rs),
[accounts](../arch-swap-router/src/accounts.rs),
[executor](../arch-swap-router/src/executor.rs),
[SDK-independent IDL tests](../arch-swap-router/tests/idl.rs),
[three-hop E2E](../arch-swap-router/tests/e2e_three_hop.rs),
[shared E2E builder](../arch-swap-router/tests/common/e2e.rs),
[vault math fixture](../arch-vaults/fixtures/client-contract.json), and
[CLAMM vectors](../arch-swap/__tests__/fixtures/clamm-swap-vectors.json).

## Frontend integration

Keep the initial deliverable to an example. The application supplies account reads,
wallet identity, deadline, and slippage. After selecting a returned quote, it can
use the Arch SDK utilities with its existing signer and transaction runner:

```ts
import {
  RUNTIME_TX_VERSION,
  SanitizedMessageUtil,
  TransactionUtil,
} from "@arch-network/arch-sdk";

// selected.instructions comes directly from quoteRoutesExactIn.
// userBytes and blockhashBytes are supplied by the application.
const message = SanitizedMessageUtil.createSanitizedMessage(
  [...selected.instructions],
  userBytes,
  blockhashBytes,
);
if (typeof message === "string") throw new Error(message);

const transaction = TransactionUtil.toNumberArray({
  version: RUNTIME_TX_VERSION,
  signatures: [],
  message,
});

await appSignAndSend(transaction, {
  submitDeadline: selected.deadlineMs,
});
```

The empty signatures above are for the application's unsigned transaction.
Size measurement inside the quote path separately accounts for real signature
length. The frontend must respect the deadline after a wallet signing delay.

Reference `../arch-swap/src/lib/arch/tx-builder.ts`,
`transaction-runner.ts`, and `../arch-swap/src/lib/indexer/accounts.ts`.
Reuse existing wallet behavior and UI state management. The frontend's existing
SDK dependency and vault registry differ; do not silently migrate them as a side
effect. Match tokens by mint, not the frontend's BTC/USD display symbols.
Use the measured router result for the final receipt, not the quote estimate.

## Checks before calling the implementation ready

- Typecheck/build, meaningful fixture tests, and browser/Node import checks.
- All 12 initial directed routes plus fixtures with competing venues; rank before
  capping, stable ties, failed candidates, no paths, and no cycle/repeated mint.
- Byte-for-byte router instruction, PDA, account-order, result, and signed-size
  agreement with Rust fixtures. Preserve duplicate fee/tick positions.
- Native vault/CLAMM rounding, management-fee accrual, full redemption coverage,
  queue state, and tick-window failures.
- Quote output instructions preserve the requested input, user, final minimum,
  and deadline. No extra reads happen during final instruction assembly.
- No public single-route/build methods, auto-refresh, hidden signing, or blockhash
  request. Transport failures are not reported as missing accounts.
- Packed package has no sibling paths, frontend aliases, or undeclared imports.
- Opt-in live tests use explicitly configured test credentials. Test direct routes
  before multi-hop routes; distinguish live results from fixture coverage.

Previous router notes report direct Mint and CLAMM success, but broader multi-hop,
missing-ATA compute, tick-crossing, and runtime rollback verification was pending.
Inspect current evidence before claiming those cases pass. Do not deploy programs,
publish packages, or run funded transactions merely to validate this handover.

Suggested starting instruction for the next agent:

> Read HANDOVER.md and src/types.ts. Implement the smallest working exact-input
> quote-to-instructions flow using @arch-network/arch-sdk types and helpers.
> Start with Rust-compatible encoding/account construction and direct Mint, then
> Redeem, CLAMM, graph discovery, and ranked/capped results. Keep the public API
> to quoteRoutesExactIn, leave refresh/signing/submission to the frontend, and
> avoid adding abstractions or dependencies without a concrete need.
