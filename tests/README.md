# Tests

`client.test.ts` verifies request validation and unsupported/identical pairs,
all before reads. It also covers default/explicit testnet metadata, immutable
selection, unknown networks, and both mainnet quote methods rejecting before reads.
`config/routes.test.ts` checks all 12 directed pairs against
native fixture paths, operation/venue order, route continuity, unique mints,
one-to-three-hop lengths, and immutable public pair metadata.
It verifies that the same paths use a selected deployment's mint addresses.

`utils.test.ts` checks shared address helpers and SDK-delegated ATA and
vault/reserve/escrow derivation against Rust account-validation fixtures. Integer
range and account-meta helpers remain covered through codec and builder tests.
It also covers ordered/deduplicated batches, null preservation, malformed
responses, and APL decoding bounds and initialization/option tags.
Receive-sizing tests bound local work, preserve u64 precision, and reject
unreachable targets or unrelated calculation errors.

`vault.test.ts` covers the native account layout, 12 Rust math vectors, fees,
virtual offsets, caps, Mint NAV boundaries, immediate-redemption eligibility,
and overflow. All four direct public quote paths match existing Rust account
lists and encode the quoted amounts, final minimum and exact deadline. Tests
verify one four-account batch, fresh subsequent reads, changed fee recipients
and queue tails, missing state, wrong owners/relationships, and transport errors.
Alternate deployment coverage verifies selected vault/mint identities, owners,
reserve/escrow/entry/event PDAs, and fee ATAs.
See [vault provenance and native behavior corrections](fixtures/vault/README.md).

`clamm.test.ts` checks native serialized pool/tick layouts, 11 native tick prices,
and 21 native swap cases. It covers both directions, negative ticks, fees and
rounding, signed liquidity crossings, empty liquidity gaps, width overflow,
three-array windows, boundary repetition and minimum-price recovery. Public
quotes cover initialized/absent arrays, malformed state and transport failures,
insufficient windows, fresh subsequent reads, and intermediate-hop failures.
All 12 fixed directions match independently composed Rust outputs and existing
Rust instruction account lists; encoded input/minimum/deadline and window
limits are verified. Direct vault quotes read once; CLAMM routes share two
batches total, with no repeated keys or construction reads. See
[CLAMM provenance and regeneration](fixtures/clamm/README.md).
Network coverage checks default/explicit testnet quote parity while a mainnet
client coexists, plus alternate CLAMM pool/mint identities, account owners,
tick/oracle PDAs and tick-to-pool validation through both loading stages.

`quoteForOutput` is tested against all 12 native composed outputs. Each result
matches a forward quote at the calculated input, while one raw input unit less
falls short. Tests retain the one-/two-batch budget and cover fixed fees, vault
caps and redemption coverage, unavailable state, tick crossings, u64-scale
inputs, rounding overshoot, final slippage, and fresh reads on subsequent calls.

`codecs/instruction.test.ts` and `codecs/result.test.ts` cover wire framing,
integer widths/ranges, step counts, both CLAMM directions, result lengths and
versions, and byte views. The strict result decoder stays internal; transaction
status and confirmation are application responsibilities. See
[codec fixture provenance](fixtures/router-codec/README.md).

`transactions/instructions.test.ts` compares the single returned router
instruction with its counterpart in all 18 original Rust fixtures. It preserves
byte/account/privilege coverage, including duplicate fee/tick positions and
native supplemental-array encoding. The fixture's leading input-ATA instruction
is deliberately not returned. The router's ATA/system trailer is retained and
construction performs no network reads.
An alternate-program test verifies the selected router and CPI programs, user
ATAs, and ATA/system trailer while preserving the native account order and bytes.

Transaction-size enforcement and tests for redundant fixed-route runtime guards
were removed under the simplification plan. Original fixture JSON, generators,
and provenance remain intact; recorded full-bundle sizes are historical metadata.
See [transaction fixture provenance](fixtures/transactions/README.md).

Next coverage: package/browser verification. No current fixture proves live
executability or adequate compute provisioning.
