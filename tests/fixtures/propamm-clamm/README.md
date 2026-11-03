# PropAMM CLAMM validator replay

This optional offline test creates real SDK quotes for all eight opted-in aETH
buy/sell directions and compiles the external PropAMM server's **unmodified**
`server/src/router_transaction.rs` into a temporary Rust binary. `verify.rs`
provides only the enclosing error and issued-quote types used by that module.
The project uses the external checkout's program/config crates and Arch/APL
0.13.0. It writes its temporary project and reusable build cache under the
system temporary directory; it does not modify the PropAMM checkout.

```sh
PROPAMM_REPO="$HOME/Arch/prop-amm" node_modules/.bin/vitest run tests/propamm-clamm.interop.test.ts
```

Cargo runs with `--offline`; its dependencies must already be cached. The normal
SDK suite skips this test unless `PROPAMM_REPO` is supplied. Source baseline
validated on 2026-11-03: PropAMM `6d700698691113117252d3e896707de88574979a`.

Inputs come from native unsigned aETH buy/sell fixtures, independent Rust vault
layouts with synthetic balances/fees and mainnet identities, a captured mainnet
CLAMM pool, and absent tick arrays. This is structural interoperability coverage;
the synthetic account state is not an execution simulation.

The replay checks canonical message acceptance, native RFQ terms, signer and
account privileges, step counts, and rejection of altered terms, CLAMM programs,
oracles and missing CLAMM configuration. Arch's runtime sanitizer and serializer
also check the complete packets with two 64-byte signature slots reserved.

| aETH sell output | Hops | Account reads | Signed bytes | Accounts |
| --- | --- | --- | --- | --- |
| aUSD | 1 | 0 | 756 | 15 |
| primeUSD | 2 | 1 | 989 | 22 |
| aBTC | 2 | 2 | 1,105 | 25 |
| primeBTC | 3 | 2 | 1,338 | 32 |

| aETH buy input | Hops | Account reads | Signed bytes | Accounts |
| --- | --- | --- | --- | --- |
| aUSD | 1 | 0 | 756 | 15 |
| primeUSD | 2 | 1 | 1,056 | 24 |
| aBTC | 2 | 2 | 1,105 | 25 |
| primeBTC | 3 | 2 | 1,405 | 34 |

Each packet is checked against its own issued quote, including the native Buy
side and prefix-sized input. RFQ-first routes report a known input to the server;
routes with a redeem/CLAMM prefix report that the input is measured on-chain.

No signatures are generated or verified; no server, RPC, submission or funded
execution is used. Runtime limits are 4,096 bytes and 50 accounts.
