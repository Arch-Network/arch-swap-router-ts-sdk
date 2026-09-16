# Tests

`client.test.ts` verifies request validation, unsupported/identical pairs, and
explicit CLAMM/multi-hop placeholders, all before reads.
`config/routes.test.ts` checks all 12 directed pairs against
native fixture paths, operation/venue order, route continuity, unique mints,
one-to-three-hop lengths, and immutable public pair metadata.

`utils.test.ts` checks shared address helpers and SDK-delegated ATA and
vault/reserve/escrow derivation against Rust account-validation fixtures. Integer
range and account-meta helpers remain covered through codec and builder tests.
It also covers ordered/deduplicated batches, null preservation, malformed
responses, and APL decoding bounds and initialization/option tags.

`vault.test.ts` covers the native account layout, 12 Rust math vectors, fees,
virtual offsets, caps, Mint NAV boundaries, immediate-redemption eligibility,
and overflow. All four direct public quote paths match existing Rust account
lists and encode the quoted amounts, final minimum and exact deadline. Tests
verify one four-account batch, fresh subsequent reads, changed fee recipients
and queue tails, missing state, wrong owners/relationships, and transport errors.
See [vault provenance and native behavior corrections](fixtures/vault/README.md).

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

Transaction-size enforcement and tests for redundant fixed-route runtime guards
were removed under the simplification plan. Original fixture JSON, generators,
and provenance remain intact; recorded full-bundle sizes are historical metadata.
See [transaction fixture provenance](fixtures/transactions/README.md).

Next coverage: CLAMM math, shared route batches, fixed-route amount
composition, and package/browser verification. No current fixture proves live
executability or adequate compute provisioning.
