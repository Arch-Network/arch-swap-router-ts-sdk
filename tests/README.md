# Tests

No functional SDK tests exist yet. The test command permits an empty suite while
the package contains only placeholders.

Add tests as behavior is implemented:

- Rust ABI, account-order, PDA, result, and signed-size fixtures.
- Vault and CLAMM quote math against their source fixtures.
- Venue graph alternatives, ranking before capping, and partial failures.
- No refresh, blockhash retrieval, or signing in the SDK.
- Browser/Node package imports and opt-in testnet routes.

All state-reading, quoting, encoding, and instruction-building functions currently
throw `NotImplementedError`.
