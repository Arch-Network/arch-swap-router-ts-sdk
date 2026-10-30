# Mainnet-v2 account snapshot

`accounts.json` is a subset of the mainnet-v2 deployment snapshot recorded by arch-prime
(`packages/sdk/test/fixtures/registry/mainnet-v2-accounts.json` at arch-prime `4246b51d`,
sha256 `9401aa51…68ab`). That file holds read-only `get_multiple_accounts` results from
`https://rpc.mainnet.arch.network`, assembled at `observedAt` (2026-10-15) during the mainnet-v2
rollout. Keys are 32-byte lowercase hex pubkeys; `owner` and `data` are lowercase hex. Lamports,
UTXO and executable state were not recorded.

The subset is exactly what a router quote reads besides tick arrays: the BTC/USD CLAMM pool, the
primeBTC and primeUSD vaults, the four mints (aBTC, aUSD, primeBTC, primeUSD) and the two vault
reserves (the token accounts each vault stores at offset 329). Tick arrays were not recorded, so
CLAMM quotes replay against an empty window.

`tests/mainnet-v2.test.ts` serves these bytes as the data source of a `network: "mainnet"` client.
Refresh only from a new deployment record; never substitute another network's accounts.
