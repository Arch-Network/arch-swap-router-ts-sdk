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

// TODO(mainnet): replace the dummy program, mint and venue addresses below.
// They are distinct valid public keys, not a deployed network configuration.
export const MAINNET = Object.freeze({
  routerProgramId: "9iY8Tr5KHUKDzgGUGY5XXvZQVV8xtCZn5dyeX2nHNycC",
  vaultProgramId: "9nTRc9YKsmcT8mWyhqQSpoLAjeMAZGFbe3eJaQpt8Jvu",
  clammProgramId: "9rNikT1LU4ugGrmV98jN7g6vyoZNEKwRCTJxdnsUseFc",
  tokenProgramId: "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk",
  associatedTokenProgramId: "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3",
  systemProgramId: "11111111111111111111111111111111",
} as const);

export const MAINNET_MINTS = Object.freeze({
  aBTC: "9vJ1tkUM4NCuQx1zaS4HQYshDxmZuPdEkrychAv5cyaK",
  aUSD: "9zDK33wMefW8Z3GW1jPChReTU7ymaTK4KGeGkYxgNJu2",
  primeBTC: "A48cBMQNExoMh8X1T2i7zJRDiHByFWzssgJvow1H7eDj",
  primeUSD: "A83uKesNqG6aqDmWtL33HBByxSQAvaghS5yasK3sryYS",
} as const);

export const MAINNET_VENUES = Object.freeze({
  btcVault: Object.freeze({
    address: "AByCTxLPRZPoyK22KdMxa3xkCbcNbeNWzVeEvh6UcJs9",
    assetMint: MAINNET_MINTS.aBTC,
    shareMint: MAINNET_MINTS.primeBTC,
  }),
  usdVault: Object.freeze({
    address: "AFtVcFoQ1rh37QGXkvgsrvjWSkpaGi4LYuJtz595MeBr",
    assetMint: MAINNET_MINTS.aUSD,
    shareMint: MAINNET_MINTS.primeUSD,
  }),
  clamm: Object.freeze({
    address: "AKonkZGQc9zGFVX3CE1o9oWGgv2mwmkA7JyZ3TBg6yWZ",
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
  readonly maker: Address;
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
      maker: "FosDeThFmSTGcaQxgyhaPWhBrnEovCJ7jHzTcwp1dmYi",
      config: "3ak4e8ZxNVYfKw8hapDvRGPKtPBSrqBYomKSQ3XMWGxM",
      baseMint: TESTNET_MINTS.aBTC, quoteMint: TESTNET_MINTS.aUSD,
    }),
  }),
  mainnet: Object.freeze({ programs: MAINNET, mints: MAINNET_MINTS, venues: MAINNET_VENUES }),
} satisfies Record<Network, NetworkConfig | null>);
