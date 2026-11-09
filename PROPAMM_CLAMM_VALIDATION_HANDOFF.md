# PropAMM handoff: CLAMM route validation

Prepared on 2026-11-03 as an implementation specification for the PropAMM
server engineer. **Follow-up:** Phase 1 changes are now present in the local
PropAMM checkout at `6d70069`, including CLAMM validation and Arch 0.13 alignment.
The SDK automatically enables native aETH buys/sells and their CLAMM
prefixes/suffixes with its mainnet quote provider, and replays all eight routes
against that unmodified validator;
the largest packet is 1,405 bytes. The live service still returns treasury
buys, so its actual market mode/deployment must serve native buys and have
aETH inventory before those live checks can pass. Treasury graph edges remain
deferred.
See [the implementation log](DYNAMIC_ROUTING_IMPLEMENTATION_PLAN.md#mixed-aethclamm-follow-up-2026-11-03)
and [the repeatable offline replay](tests/fixtures/propamm-clamm/README.md).
The original baseline and requirements below record the handoff's starting point.
Merge/deployment and mixed-route live validation remain with the caller. The
actual server is `https://vaults.veloxapi.net/propamm`; its deployment config
is separate from the repository's checked-in `mainnet-v2.toml`.

The target checkout is `~/Arch/prop-amm` (with a hyphen), alongside
`~/Arch/arch-swap-router` and this TypeScript SDK. `~/Arch/propamm` does not
exist in the inspected workspace.

## Goal, scope, and source of truth

Allow the RFQ signing server to validate and co-sign router transactions that
combine CLAMM steps with **exactly one native PropAMM RFQ**, preserving the
existing limit of three total hops. Include SDK/runtime compatibility work so
larger mixed routes can eventually pass server sanitization. Multiple RFQs are
a separate, coordinated follow-up described at the end of this document.

The user selected CLAMM first plus a multi-RFQ roadmap, and explicitly included
transaction-size compatibility work. Treasury-mint composition, receive sizing,
live smoke tests, funded execution, and deployment are outside this workstream.
Offline validation and co-signing regression tests are part of implementation.

Inspected baselines:

| Repository | Revision | Relevant implementation |
| --- | --- | --- |
| `prop-amm` | `bfe34e21f832c9bd4f7793b18a81955fb7c1936e` | `server/src/router_transaction.rs`, `server/src/routes/rfq.rs`, `server/src/rfq.rs`, `config/src/lib.rs` |
| `arch-swap-router` | `ef7920a28b8e4bd959e1caeabb9ded0002e8903b` | `src/instruction.rs`, `src/accounts.rs`, `src/adapters/clamm.rs`, `src/utils/clamm.rs`, `src/executor.rs` |
| This SDK | Current workspace | `src/config/routes.ts`, `src/codecs/instruction.ts`, `src/transactions/instructions.ts`, `src/quote-candidates.ts` |

Paths in this table are relative to their respective repositories. Recheck the
working tree and revisions before implementing; preserve unrelated changes.
These are source baselines, not proof of the deployed program/server revision.

### Current boundary

- The on-chain router already decodes CLAMM steps and executes CLAMM and PropAMM
  adapters sequentially. Its executor supplies each hop with the preceding
  hop's measured credit, checks exact input debits, and enforces the route's
  signed final-output minimum.
- The server only decodes vault Mint (`0`), Redeem (`1`), and PropAMM (`3`). Its
  route whitelist accepts RFQ, Redeem/RFQ, RFQ/Mint, and Redeem/RFQ/Mint.
- The server returns `None` for RFQ input only when the route starts with
  redemption. This must also handle a preceding CLAMM swap.
- The server currently uses one quote ID, one maker, and two required signer
  slots. Retain those contracts for Phase 1.
- The SDK currently marks its PropAMM markets `allowClamm: false`. Its optional
  composable aETH sells support aETH -> aUSD and aETH -> aUSD -> primeUSD only.
  Server acceptance is a prerequisite for enabling additional SDK paths.
- The existing direct treasury buy is not a native PropAMM hop. Do not interpret
  or extract it as one. Supporting mixed native RFQ routes does not make aETH
  treasury buys composable.

No on-chain routing operation or wire-format change is required for Phase 1.

## Phase 1 implementation contract

### 1. Add explicit CLAMM configuration

Add `clamm_program_id: Option<String>` to `RouterConfig`, using the same
optional-public-key parsing/default/serialization conventions as
`vault_program_id`. Carry it into `RouterPrograms` as an optional parsed key.

- Omission disables routes containing CLAMM, while preserving existing routes.
- Configure the program trusted by the selected router build; reject a different
  program key in a submitted CLAMM account group.
- Preserve existing configuration parsing and error behavior. Document the new
  field in the server README and appropriate deployment-config examples.

For the SDK's current mainnet-v2 profile, the router is
`Bu8JuhykFEtJmUqYV98zJDtPr2J7LBMbEJX8DeT7XSeT` and CLAMM is
`AzvVQ4qV2DnokUgtxskJ2V11BP5M5Fvx51G3aUgnZm7A`. These are examples for that
profile, not replacements for all network defaults. The router's stage workflow
binds venue IDs per build; its legacy source defaults use other identities.

### 2. Decode the existing router ABI and extend route validation

Keep the 26-byte `RouteExactInV1` header, unchanged CompactQuote terms, and strict
framing checks. Add a typed CLAMM step to the server's internal step enum.

| Offset within CLAMM step | Length | Value |
| --- | --- | --- |
| 0 | 1 byte | Step tag `2` |
| 1 | 1 byte | `a_to_b`, strictly `0` or `1` |
| 2 | 16 bytes | `sqrt_price_limit`, unsigned little-endian u128 |
| 18 | 1 byte | Supplemental tick-array count, `0..3` |

The complete CLAMM step is **19 bytes**, including its tag. Preserve the encoded
price limit without inventing a server pricing policy or rejecting values
otherwise accepted by the native ABI. Truncated fields, invalid direction bytes,
excessive supplemental counts, unsupported tags, and trailing bytes must reject
without panicking.

Replace the four-shape whitelist with these bounded rules:

- Require one to three total steps and **exactly one** native PropAMM RFQ.
- Allow zero, one, or two CLAMM steps before/after that RFQ within the hop limit.
- Allow at most one vault Redeem as the first step and at most one vault Mint
  as the last step. Do not add interior vault operations.
- Preserve the existing RFQ-only and vault/RFQ routes.
- Reject zero-RFQ router submissions through this RFQ endpoint, a second RFQ,
  repeated route mints, and unsupported shapes or framing.

This includes RFQ/CLAMM, CLAMM/RFQ, RFQ/CLAMM/Mint,
Redeem/CLAMM/RFQ, and CLAMM/RFQ/CLAMM. A particular market direction remains
available only if the server issues the corresponding native RFQ.

### 3. Reconstruct account groups and canonical privileges

Read all route nodes first, then each venue group in step order, using the
router's positional ABI. A CLAMM group has **8 + supplemental-count positions**:

| Position | Account | Expected privilege |
| --- | --- | --- |
| 0 | Configured CLAMM program | Read-only, non-signer |
| 1 | Pool | Writable, non-signer |
| 2 | Token vault A | Writable, non-signer |
| 3 | Token vault B | Writable, non-signer |
| 4, 5, 6 | Three primary tick-array positions | Writable, non-signer |
| 7 | Oracle | Writable, non-signer |
| 8 onward | Exactly the declared supplemental tick arrays | Writable, non-signer |

Require the oracle PDA derived from `[b"oracle", pool_pubkey]` under the
configured CLAMM program. Preserve valid repeated primary tick positions and
the supplied account ordering. Do not deduplicate positional account groups;
canonical compilation deduplicates message keys and merges their privileges.

Keep the existing node rules: canonical ATAs for the same user, writable ATAs,
and read-only mints except the initial redeemed share mint or final minted share
mint. Retain the existing PropAMM/vault account validation and group lengths.

Rebuild the complete expected message with native `ArchMessage::new`, retaining
the submitted blockhash, and require equality with the submitted message. Accept
the existing optional idempotent input-ATA instruction and optional router
ATA/System trailer. Reject other outer instructions, unused keys, extra/missing
accounts, and unauthorized privileges.

Retain the writable user fee payer, read-only maker signer, two required signer
slots, user-signature verification, and the restriction that the maker appears
exactly once and only in the PropAMM maker position. CLAMM introduces no new
signer and must not receive the maker as a node, pool, tick, vault, or fee account.

### 4. Preserve the boundary between server and on-chain validation

Follow the existing trusted-router model. Do not add server-side CLAMM pricing,
simulation, pool/tick RPC reads, or a new pool allowlist for this phase.

| Server signing validator | Trusted router / CLAMM execution |
| --- | --- |
| Framing, configured program key, positional account layout, canonical privileges, oracle derivation, and RFQ authorization | Executable programs; pool ownership, discriminator, canonical PDA and mint relationship; vault identities/authority; tick ownership, association and sequence; native pricing and price-limit rules |

The router's CLAMM adapter and native CLAMM program collectively enforce the
right-hand column. The server must not claim to have verified mutable pool/tick
state it did not fetch. Preserve native acceptance of repeated tick positions
and valid absent/empty tick accounts; execution remains authoritative.

### 5. Correct RFQ input classification and preserve quote authorization

Use the RFQ's position to determine whether its input amount is known:

| RFQ position | Validator result | Server preflight input |
| --- | --- | --- |
| First route step | `Some(route.amount_in)` | Original route input |
| After any CLAMM or Redeem step | `None` | Existing issued quote's input amount, as for redemption today |

Return `Some` only when the RFQ step index is zero. The current
`if redeem { None } else { Some(amount_in) }` rule is insufficient.

In particular, an original aBTC amount cannot be used as an aUSD RFQ input just
because both are u64 values. The actual intermediate input remains measured at
execution and subject to native PropAMM input bounds. Preflight acceptance does
not guarantee that subsequent state changes will leave a route executable.

Retain exact binding to the issued quote's compact terms, user, base/quote mints,
side, maker, config, nonce, expiry, and quote ID. Preserve the existing maker
price/freshness checks and user authentication before claiming a quote.

Keep the signed final-output minimum and route deadline. Do not apply the direct
RFQ's output minimum to an intermediate token or share output, and do not apply
slippage again in the server. Continue requiring a fresh route deadline no later
than the issued RFQ expiry. Keep the existing quote claim, message binding,
retry, and completion behavior unchanged for this single-RFQ phase.

### 6. Resolve transaction-size compatibility before enabling larger routes

The server pins Rust `arch_sdk = 0.12.0`, whose `RuntimeTransaction` sanitizer
enforces **1,232 bytes**. The TypeScript SDK's installed dependency allows
**4,096 bytes and 50 unique account keys**. These limits are not interchangeable.

Local structural measurements using mainnet-v2 account identities, zero
supplemental arrays, canonical `[input ATA, router]` bundles, and both required
signature slots give:

| Illustrative route | Serialized bytes | Unique account keys |
| --- | --- | --- |
| aETH -> aUSD -> aBTC (PropAMM/CLAMM) | 1,105 | 25 |
| aETH -> aUSD -> aBTC -> primeBTC (PropAMM/CLAMM/Mint) | 1,338 | 32 |

These are construction measurements, not executable quotes or universal sizes;
different account aliases, fee destinations, or tick supplements change them.
The three-hop example cannot pass the server's current sanitizer merely by
adding CLAMM decoding.

Include the following compatibility work in the implementation:

1. Verify the target deployment's runtime size/account contract and identify a
   compatible Rust SDK/dependency set. Record the exact versions and evidence;
   a TypeScript SDK constant alone does not establish the deployed runtime.
2. Align server dependencies and sanitization with that verified contract.
   Preserve message serialization, canonical account ordering, user-signature
   verification, and existing direct/RFQ regression behavior.
3. Enforce dependency-supplied limits on the complete transaction with every
   required signature slot reserved. Keep validation before signing/claiming.
4. Retain the current effective limit until alignment is verified. Larger mixed
   routes must remain disabled and must not be advertised as executable.

Do not bypass sanitization or introduce a hardcoded limit override. Coordinate
with SDK eligibility checks so it does not advertise server-incompatible routes.

## Offline validation, implementation order, and acceptance

Use the existing server router validation/signing fixtures and the router's
native CLAMM account/ABI fixtures as the foundation. Add independently generated
mixed-route fixtures rather than deriving expected bytes with the SDK under test.

Required cases:

- [ ] CLAMM before/after RFQ; RFQ at positions 0, 1, and 2; both CLAMM directions;
  allowed vault prefixes/suffixes; existing RFQ-only/vault routes.
- [ ] Supplemental counts 0..3, legitimate repeated primary tick positions,
  optional input-ATA and trailer layouts, and exact canonical message equality.
- [ ] Unknown tags, invalid direction bytes, all truncated payload boundaries,
  excessive counts, trailing data/accounts, zero/two RFQs, repeated route mints,
  and prohibited vault placement.
- [ ] Missing CLAMM configuration, untrusted programs, incorrect oracle,
  extra signer/writable privileges, unused keys, and maker aliases outside its
  RFQ position. Pool/tick state failures remain on-chain checks, not claimed
  server-side rejections without state reads.
- [ ] RFQ user, mint, side, term, amount, nonce, expiry, and quote-ID substitutions;
  expired deadlines; incorrect original-input units after CLAMM.
- [ ] Dependency byte/account boundaries with missing eventual signatures
  reserved, the larger mixed-route compatibility example, and existing message
  compilation/serialization regressions after dependency alignment.
- [ ] User-signature verification and co-signing preserve the complete original
  user-signed message; invalid authorization cannot claim/bind a quote.
- [ ] Existing direct, vault/RFQ, liquidation, looping, and applicable treasury
  flows retain their prior behavior. Quote retries remain bound to one message.

Recommended implementation order: establish native fixtures; add optional
configuration; extend step decoding and bounded route grammar; reconstruct CLAMM
accounts; correct input classification; complete dependency/runtime compatibility;
run regression/signing tests; document the enabled deployment capabilities.

From the PropAMM repository, with locked dependencies cached:

```sh
cargo test --locked --offline -p propamm-config
cargo test --locked --offline -p prop-amm-server
cargo check --locked --offline -p prop-amm-server
```

If dependencies are not cached, omit `--offline` to fetch the locked dependency
set. Deliberate dependency-alignment changes must update the lockfile first and
then rerun the locked checks. Record the final commits, SDK/runtime profile,
supported route shapes, fixture provenance, test commands/results, and blockers.

Phase 1 is complete when supported mixed messages pass the validator and offline
co-signing checks; invalid authorizations fail before signing/claiming; existing
contracts remain compatible; and the SDK only enables capabilities the server
and target runtime support. Keep `allowClamm: false` until coordinated server
rollout is verified. Native aETH sells can be exercised by the new grammar;
native aETH buys additionally require an appropriate quote-issuing mode.

Live smoke tests, real co-signing/submission, funded execution, and deployment
remain deferred. This handoff does not authorize or claim those operations.

## Multi-RFQ roadmap: a separate coordinated change

Do not implement this by only relaxing the server's route whitelist. The current
router rejects a second RFQ in both instruction decoding and account reading,
and the SDK repeats that restriction in graph discovery, encoding, and bundle
construction. These components must change together.

The future design must address:

1. **Router/SDK bounds and encoding.** Review the permitted RFQ count, total hop
   count, account layout, transaction limits, and compatibility/version policy.
   The existing executor's sequential-credit model alone is not sufficient.
2. **Per-step quote mapping.** Replace the single-quote assumption with an
   unambiguous association between each RFQ step and its issued quote ID. Reject
   missing, duplicate, unrelated, or mismatched quote authorizations. Plan the
   corresponding SDK result/provider and submission-interface changes while
   preserving existing single-quote clients.
3. **Atomic quote claims and retries.** Validate and authenticate the complete
   message before claiming its quotes. Claim/bind the complete quote set to one
   message together; define coherent concurrent-submission, release, uncertain
   submission, and completion behavior. Do not leave a partially claimed set.
4. **Nonce ordering.** Native PropAMM advances the user/config nonce to
   `quote.nonce + 1`. RFQs sharing that nonce account need increasing nonces in
   execution order; same-millisecond issuance can otherwise make the second hop
   fail. Address allocation and concurrent quote issuance explicitly.
5. **Maker signatures and account positions.** The current maker-occurs-once
   restriction and exactly-two-signatures assumptions must change. Distinguish
   repeated authorized maker positions from use outside RFQ groups; determine
   support for shared versus distinct makers and count unique signer slots.
6. **Every RFQ's authorization and freshness.** Validate each quote's user,
   market/config/maker, compact terms, amount bounds, and price policy. Require
   the route deadline to respect every RFQ expiry and recheck freshness after
   all preflight work.
7. **Intermediate amounts and shared inventory.** Each RFQ may consume a measured
   intermediate amount. Account for preceding trades changing shared vault
   balances and inventory skew, and retain native input-range checks and the
   signed final-output floor. Independent preflight estimates must not be
   presented as a simulation or execution guarantee.
8. **Complete transaction compatibility.** Include every required signature and
   compiled account key in eligibility checks; add native multi-RFQ and replay/
   concurrency fixtures across server, router, and SDK.

These are requirements for a later design, not permission to enable multiple
RFQs during Phase 1. Treasury-mint routes remain a different execution capability
and are not made composable by adding RFQ count or CLAMM support.
