import type { Address } from "../types.js";

/** Fixed deployments; callers select a network rather than supplying addresses. */
export const TESTNET = Object.freeze({
  routerProgramId: "E5j9e2KTsP3cfde7ao8JvkCQzeMC2oKFB3JaaSVps2Uo",
  vaultProgramId: "DXSMCcZfjMXe1HTNF1m2CJ5L8zj1cLAKG8SrLvtb3mRa",
  clammProgramId: "g478Wr3iDLR4NSwE8jj2ufKWw5rZxyR4UCKtVJMBnNK",
  tokenProgramId: "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk",
  associatedTokenProgramId: "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3",
  systemProgramId: "11111111111111111111111111111111",
} as const);

export const TESTNET_MINTS = Object.freeze({
  aBTC: "2yHWVNYyjnsxZqpnvTbPzWiHwpNQ2zBQU6BC4Lnbu7sW",
  aUSD: "6mqUuwPYehXei6mGBY4bQ6XK1z7e6rrFAZRzYKdH8qkp",
  primeBTC: "5Ba27gr7DPWvR8oyNZ3q3Jn2cKK2KLEpSgcggzbTQ1fh",
  primeUSD: "FynmgKXHUgVUToj9LSixpcXq8YirSekcxQjnebkeJ427",
} as const);

export const TESTNET_VENUES = Object.freeze({
  btcVault: Object.freeze({
    address: "6H4kmh2TKpkXH5sVCMMEThVZyZSXrsvPEpipY8aFoDF7",
    assetMint: TESTNET_MINTS.aBTC,
    shareMint: TESTNET_MINTS.primeBTC,
  }),
  usdVault: Object.freeze({
    address: "CBiMudmQp9i1ZSMRApZTBAaAzdbRnDsHTaoN2YnXqBxC",
    assetMint: TESTNET_MINTS.aUSD,
    shareMint: TESTNET_MINTS.primeUSD,
  }),
  clamm: Object.freeze({
    address: "6wTjE3LPV8YcoDR4yPQEvpy8KmZEMo3g1iGXpTmpFYUJ",
    tokenMintA: TESTNET_MINTS.aBTC,
    tokenMintB: TESTNET_MINTS.aUSD,
  }),
});

// mainnet-v2 deployment. Account evidence: tests/fixtures/mainnet-v2/accounts.json (mainnet RPC, 2026-10-15):
// owners, mint decimals (8/6/8/6), vault asset/share mints and the pool's token order (aBTC as token A).
export const MAINNET = Object.freeze({
  routerProgramId: "Bu8JuhykFEtJmUqYV98zJDtPr2J7LBMbEJX8DeT7XSeT",
  vaultProgramId: "BtPdgu3v6ruKYbhiuGLEx7Fa4rU6f15maftGhNRTP32L",
  clammProgramId: "AzvVQ4qV2DnokUgtxskJ2V11BP5M5Fvx51G3aUgnZm7A",
  tokenProgramId: "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk",
  associatedTokenProgramId: "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3",
  systemProgramId: "11111111111111111111111111111111",
} as const);

export const MAINNET_MINTS = Object.freeze({
  aBTC: "78s6DsmwRnCYiQDvAKbJoeAbGDa68zifa1cgqTb4tBbM",
  aUSD: "DQcBfwHu8gr8KGt3BE5BDUfBjGgFuDJYm9ByVTDsrww9",
  primeBTC: "Bg138vbUo1h3cvRBQ9yRdqbGX2Cm2pwRexj1LaVVTQYj",
  primeUSD: "C9fDCY2oJjM3KUHGkr5TidcbJMz7Me9FHHBR2YDnGVrK",
} as const);

export const MAINNET_VENUES = Object.freeze({
  btcVault: Object.freeze({
    address: "DWCi7kuDVBESrZUqNMwX54BW8DgMPS1GTZqANAD9n31t",
    assetMint: MAINNET_MINTS.aBTC,
    shareMint: MAINNET_MINTS.primeBTC,
  }),
  usdVault: Object.freeze({
    address: "9pzq5sCYyx2KjEtTcXyTHmYeiXmBerzfaVKXWDbQANkz",
    assetMint: MAINNET_MINTS.aUSD,
    shareMint: MAINNET_MINTS.primeUSD,
  }),
  clamm: Object.freeze({
    address: "BFfBYemdhWnnKtWbz3fkKwr7qnXbFCNjVGnoDygXokA8",
    tokenMintA: MAINNET_MINTS.aBTC,
    tokenMintB: MAINNET_MINTS.aUSD,
  }),
});

export type Network = "testnet" | "mainnet";
export type NetworkMints = Readonly<Record<keyof typeof TESTNET_MINTS, Address>>;
export type ProgramIds = Readonly<Record<keyof typeof TESTNET, Address>>;
export interface VaultVenue {
  readonly address: Address;
  readonly assetMint: Address;
  readonly shareMint: Address;
}
export interface PropAmmDeployment {
  readonly programId: Address;
  readonly config: Address;
  readonly baseMint: Address;
  readonly quoteMint: Address;
}
export interface NetworkConfig {
  readonly programs: ProgramIds;
  readonly mints: NetworkMints;
  readonly propamm?: PropAmmDeployment;
  readonly venues: {
    readonly btcVault: VaultVenue;
    readonly usdVault: VaultVenue;
    readonly clamm: {
      readonly address: Address;
      readonly tokenMintA: Address;
      readonly tokenMintB: Address;
    };
  };
}

export const NETWORKS = Object.freeze({
  testnet: Object.freeze({
    programs: TESTNET, mints: TESTNET_MINTS, venues: TESTNET_VENUES,
    propamm: Object.freeze({
      programId: "9EqAsENtgBA4Uo4wbS8LVdaQJjMKPpagMxgDVhxEWtKq",
      config: "7X7QM1eEQwgE9b6tA4HMGxWGdzuTvcU9ip9FeZS338yn",
      baseMint: TESTNET_MINTS.aBTC, quoteMint: TESTNET_MINTS.aUSD,
    }),
  }),
  mainnet: Object.freeze({
    programs: MAINNET, mints: MAINNET_MINTS, venues: MAINNET_VENUES,
    propamm: Object.freeze({
      programId: "5KMw4VNavLhM5wxTxyQGm8hs5ymFhqMCZ5BpkHybcEBV",
      config: "5hHjjURFFJS33k6H98p8Jw1s6cuE9RPQ8puDCnrHoRwb",
      baseMint: MAINNET_MINTS.aBTC, quoteMint: MAINNET_MINTS.aUSD,
    }),
  }),
} satisfies Record<Network, NetworkConfig | null>);
