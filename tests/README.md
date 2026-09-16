# Tests

`client.test.ts` verifies the compact public API: supported requests remain
explicitly unimplemented, unsupported/identical pairs fail, and neither makes
account reads. `config/routes.test.ts` checks all 12 directed pairs against
native fixture paths, operation/venue order, route continuity, unique mints,
one-to-three-hop lengths, and immutable public pair metadata.

`utils.test.ts` checks shared address helpers and SDK-delegated ATA and
vault/reserve/escrow derivation against Rust account-validation fixtures. Integer
range and account-meta helpers remain covered through codec and builder tests.

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

Next coverage: actual vault/CLAMM math, batched reader behavior, fixed-route amount
composition, and package/browser verification. No current fixture proves live
executability or adequate compute provisioning.
