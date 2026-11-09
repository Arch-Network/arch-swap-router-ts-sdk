# PropAMM native and treasury validator replay

This optional offline test creates real SDK quotes for all eight mainnet buy/sell
directions of each asset, aETH and aHYPE, and all four treasury-buy routes per asset with both fixed (0 bps)
and bounded (50 bps) issued authorization: 32 packets total. It compiles the
external PropAMM server's **unmodified** `server/src/router_transaction.rs`,
`treasury_routing.rs` and `treasury_mint.rs` into a temporary Rust binary.
`verify.rs` provides minimal surrounding types and context helpers for market
selection and payout checks; quotes use no engine payout cap. The actual server
authorization math and native payment/mint builder authenticate the issued
terms independently of SDK encoding.
The project uses the external checkout's program/config crates and Arch/APL
0.13.0. It writes its temporary project and reusable build cache under the
system temporary directory; it does not modify the PropAMM checkout.

```sh
PROPAMM_REPO="$HOME/Arch/prop-amm" node_modules/.bin/vitest run tests/propamm-clamm.interop.test.ts
```

Cargo runs with `--offline`; its dependencies must already be cached. The normal
SDK suite skips this test unless `PROPAMM_REPO` is supplied. Source baseline
validated on 2026-11-09: PropAMM `a6ad7a7` (includes treasury routing from `867859b`).
The older `6d700698691113117252d3e896707de88574979a` baseline predates treasury
support and cannot run this replay.

Inputs come from native unsigned aETH fixtures and captured aHYPE packets, independent Rust vault
layouts with synthetic balances/fees and mainnet identities, a captured mainnet
CLAMM pool, and absent tick arrays. This is structural interoperability coverage;
the synthetic account state is not an execution simulation.

The replay checks canonical message acceptance, native RFQ terms, signer and
account privileges, step counts, and rejection of altered terms, CLAMM programs,
oracles and missing CLAMM configuration. Treasury checks additionally reject
changes to all six terms, the bridge, authority, payment vault, output mint and
recipient ATA; read-only treasury signers; missing issued authorization; and
invented fixed bounds substituted for the issued interval. Arch's runtime
sanitizer and serializer also check complete packets with two 64-byte signature slots reserved.

| Native sell output, per asset | Hops | Account reads | Signed bytes | Accounts |
| --- | --- | --- | --- | --- |
| aUSD | 1 | 0 | 756 | 15 |
| primeUSD | 2 | 1 | 989 | 22 |
| aBTC | 2 | 2 | 1,105 | 25 |
| primeBTC | 3 | 2 | 1,338 | 32 |

| Native buy input, per asset | Hops | Account reads | Signed bytes | Accounts |
| --- | --- | --- | --- | --- |
| aUSD | 1 | 0 | 756 | 15 |
| primeUSD | 2 | 1 | 1,056 | 24 |
| aBTC | 2 | 2 | 1,105 | 25 |
| primeBTC | 3 | 2 | 1,405 | 34 |

Each packet is checked against its own issued quote, including the native Buy
side and prefix-sized input. RFQ-first routes report a known input to the server;
routes with a redeem/CLAMM prefix report that the input is measured on-chain.

| Treasury buy input, per asset | Hops | Account reads | Signed bytes | Accounts |
| --- | --- | --- | --- | --- |
| aUSD | 1 | 0 | 862 | 17 |
| primeUSD | 2 | 1 | 1,162 | 26 |
| aBTC | 2 | 2 | 1,211 | 27 |
| primeBTC | 3 | 2 | 1,511 | 36 |

Both assets and issued authorization ranges produce the same packet lengths. Original
unsigned payment/mint packets are preserved and rebuilt by the real server
builder during validation. A fixed range is valid only when it was issued as
such; omitted metadata never authorizes the SDK to invent one.

No signatures are generated or verified; no server, RPC, submission or funded
execution is used. Runtime limits are 4,096 bytes and 50 accounts.
