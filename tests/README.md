# Tests

`accounts/pda.test.ts` verifies SDK-delegated ATA and vault/reserve/escrow PDA
derivation against the Rust router's `tests/account_validation.rs` fixtures.
It also checks malformed public keys and leading zero bytes in base58 decoding.

Add tests as behavior is implemented:

- Rust ABI, account-order, PDA, result, and signed-size fixtures.
- Vault and CLAMM quote math against their source fixtures.
- Venue graph alternatives, ranking before capping, and partial failures.
- No refresh, blockhash retrieval, or signing in the SDK.
- Browser/Node package imports and opt-in testnet routes.

All state-reading, quoting, encoding, and instruction-building functions currently
throw `NotImplementedError`.
