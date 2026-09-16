import type { RouterDeployment, VenueConfig } from "../types.js";

export const TESTNET = {
  network: "testnet",
  routerProgramId: "E5j9e2KTsP3cfde7ao8JvkCQzeMC2oKFB3JaaSVps2Uo",
  vaultProgramId: "DXSMCcZfjMXe1HTNF1m2CJ5L8zj1cLAKG8SrLvtb3mRa",
  clammProgramId: "g478Wr3iDLR4NSwE8jj2ufKWw5rZxyR4UCKtVJMBnNK",
  tokenProgramId: "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk",
  associatedTokenProgramId: "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3",
  systemProgramId: "11111111111111111111111111111111",
} as const satisfies RouterDeployment;

export const TESTNET_MINTS = {
  aBTC: "2yHWVNYyjnsxZqpnvTbPzWiHwpNQ2zBQU6BC4Lnbu7sW",
  aUSD: "6mqUuwPYehXei6mGBY4bQ6XK1z7e6rrFAZRzYKdH8qkp",
  primeBTC: "5Ba27gr7DPWvR8oyNZ3q3Jn2cKK2KLEpSgcggzbTQ1fh",
  primeUSD: "FynmgKXHUgVUToj9LSixpcXq8YirSekcxQjnebkeJ427",
} as const;

export const TESTNET_VENUES = [
  {
    id: "prime-btc",
    kind: "vault",
    address: "6H4kmh2TKpkXH5sVCMMEThVZyZSXrsvPEpipY8aFoDF7",
    assetMint: TESTNET_MINTS.aBTC,
    shareMint: TESTNET_MINTS.primeBTC,
  },
  {
    id: "prime-usd",
    kind: "vault",
    address: "CBiMudmQp9i1ZSMRApZTBAaAzdbRnDsHTaoN2YnXqBxC",
    assetMint: TESTNET_MINTS.aUSD,
    shareMint: TESTNET_MINTS.primeUSD,
  },
  {
    id: "abtc-ausd-clamm",
    kind: "clamm",
    address: "6wTjE3LPV8YcoDR4yPQEvpy8KmZEMo3g1iGXpTmpFYUJ",
    tokenMintA: TESTNET_MINTS.aBTC,
    tokenMintB: TESTNET_MINTS.aUSD,
  },
] as const satisfies readonly VenueConfig[];
