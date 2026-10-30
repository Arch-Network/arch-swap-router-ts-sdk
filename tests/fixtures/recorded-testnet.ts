// The testnet deployment the Rust fixtures under tests/fixtures/ were generated against (router E5j9e…, built from
// arch-swap-router `src/ids.rs` with `--features testnet`). It is still on chain but superseded by testnet-v2, which
// `src/config/networks.ts` exports; tests/setup.ts substitutes this deployment for `testnet` so the fixtures replay
// unchanged. tests/config/networks.test.ts checks the exported testnet-v2 constants directly.
export const RECORDED_TESTNET = Object.freeze({
  routerProgramId: "E5j9e2KTsP3cfde7ao8JvkCQzeMC2oKFB3JaaSVps2Uo",
  vaultProgramId: "DXSMCcZfjMXe1HTNF1m2CJ5L8zj1cLAKG8SrLvtb3mRa",
  clammProgramId: "g478Wr3iDLR4NSwE8jj2ufKWw5rZxyR4UCKtVJMBnNK",
  tokenProgramId: "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk",
  associatedTokenProgramId: "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3",
  systemProgramId: "11111111111111111111111111111111",
} as const);

export const RECORDED_TESTNET_MINTS = Object.freeze({
  aBTC: "2yHWVNYyjnsxZqpnvTbPzWiHwpNQ2zBQU6BC4Lnbu7sW",
  aUSD: "6mqUuwPYehXei6mGBY4bQ6XK1z7e6rrFAZRzYKdH8qkp",
  primeBTC: "5Ba27gr7DPWvR8oyNZ3q3Jn2cKK2KLEpSgcggzbTQ1fh",
  primeUSD: "FynmgKXHUgVUToj9LSixpcXq8YirSekcxQjnebkeJ427",
} as const);

export const RECORDED_TESTNET_VENUES = Object.freeze({
  btcVault: Object.freeze({
    address: "6H4kmh2TKpkXH5sVCMMEThVZyZSXrsvPEpipY8aFoDF7",
    assetMint: RECORDED_TESTNET_MINTS.aBTC,
    shareMint: RECORDED_TESTNET_MINTS.primeBTC,
  }),
  usdVault: Object.freeze({
    address: "CBiMudmQp9i1ZSMRApZTBAaAzdbRnDsHTaoN2YnXqBxC",
    assetMint: RECORDED_TESTNET_MINTS.aUSD,
    shareMint: RECORDED_TESTNET_MINTS.primeUSD,
  }),
  clamm: Object.freeze({
    address: "6wTjE3LPV8YcoDR4yPQEvpy8KmZEMo3g1iGXpTmpFYUJ",
    tokenMintA: RECORDED_TESTNET_MINTS.aBTC,
    tokenMintB: RECORDED_TESTNET_MINTS.aUSD,
  }),
});

export const RECORDED_TESTNET_PROPAMM = Object.freeze({
  programId: "9EqAsENtgBA4Uo4wbS8LVdaQJjMKPpagMxgDVhxEWtKq",
  config: "7X7QM1eEQwgE9b6tA4HMGxWGdzuTvcU9ip9FeZS338yn",
  baseMint: RECORDED_TESTNET_MINTS.aBTC, quoteMint: RECORDED_TESTNET_MINTS.aUSD,
});
