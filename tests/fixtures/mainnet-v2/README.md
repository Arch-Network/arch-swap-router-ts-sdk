# Mainnet-v2 account metadata

`accounts.json` contains public account snapshots read from the listed Arch RPC
on 2026-11-02. They verify deployment identities, mint decimals, CLAMM token
ordering, vault relationships, and the shared BTC/ETH PropAMM config.

These are metadata regression fixtures, not a synchronized liquidity snapshot
or executable quote. The PropAMM account was still v3/115 bytes when read;
native v4 decoding is tested in the on-chain router repository. No private keys,
signatures, or funded transactions are involved.
