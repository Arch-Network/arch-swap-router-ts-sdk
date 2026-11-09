# aHYPE deployment and unsigned quote fixtures

`deployment.json` captures public mainnet data on 2026-11-09 from
`https://vaults.veloxapi.net/propamm` and `https://rpc.mainnet.arch.network`.
The service reports build `40dd005cae1c3a6aa6225fa5f54998fd64069422`.
The `captured_at` timestamp precedes the independent requests; this is not a
synchronized liquidity snapshot. No wallet or server signatures were requested.
The quotes have expired and must never be submitted.

The fixture contains the actual APL mint, base-vault and bridge-asset account
images, plus original unsigned buy/sell transactions for the Rust fixtures'
public dummy user. The buy spends 1,000,000 aUSD base units; the sell spends
1,000,000 aHYPE base units. Mint/vault addresses, 9 base decimals, mint authority,
treasury-enabled asset state and dedicated treasury authority are checked in
`tests/config/ahype-usd.test.ts`. The buy uses APL transfer plus bridge tag 21
and includes the exact issued authorization. The sell is a 50-byte native
PropAMM trade with an explicit minimum output and all 13 creation accounts.

`tests/fixtures/composable-ahype.ts` resizes these packets and moves expiry to
the common test clock for synthetic route quotes. Its optional native buy uses
the native sell builder's shared account layout with buy-side terms. Such resized
packets are test data, not historical market quotes. Vault state, absent ticks
and prefix estimates are synthetic and are not an execution simulation.

The optional external validator replay independently checks both native sides
and all four treasury routes against the real server modules and native builder.
The live quote smoke suite requests fresh quotes for all eight HYPE directions:

```sh
ARCH_RPC_URL=https://rpc.mainnet.arch.network \
  node_modules/.bin/vitest run tests/quote.e2e.test.ts -t aHYPE
```

These checks cover account/packet compatibility and quote preparation. They do
not establish signature verification, co-signing, runtime rollback or funded
on-chain execution.
