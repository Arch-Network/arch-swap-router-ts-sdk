import type { Address } from "../types.js";

/** Fixed deployments; callers select a network rather than supplying addresses. */
// testnet-v2: arch-infrastructure stage outputs (run 38264455030) and arch-swap-router `.github/workflows/arch-program.yml`
// route pins; read from testnet RPC on 2026-10-29: the router binary embeds exactly these vault, CLAMM and PropAMM
// program ids, the pool orders aBTC as token A, and mint decimals are 8/6/8/6.
export const TESTNET = Object.freeze({
  routerProgramId: "HmJrj8ZFkxFBYB77EAkjAWk7phoUSyQ8rXhCxTHMv3vD",
  vaultProgramId: "AeV5Dfxk1bwcMUgxsWQwFDUBHYUtxgQdtXyDRkMRxeZ8",
  clammProgramId: "yU7MmZLCjRpq7WFQDeHjX1EMHayJZpp37umCLAE6JR8",
  tokenProgramId: "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk",
  associatedTokenProgramId: "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3",
  systemProgramId: "11111111111111111111111111111111",
} as const);

export const TESTNET_MINTS = Object.freeze({
  aBTC: "Abudp7WD4skRhkiJmJMS4ATDybqMGpvmeMDE9LN3TLpt",
  aUSD: "DMBcvr9q687eZTkBeiTM1dWN56H7kwz1GkGWsmNa9F95",
  primeBTC: "wqngD28BT4ELuhSQ7KKRY5TK6uBZk2E9DL1ecDdjkfx",
  primeUSD: "8dhPwaUdt7qM2VBrb6zX7S1YhR56iED4TouxNJ2e1g6w",
} as const);

export const TESTNET_VENUES = Object.freeze({
  btcVault: Object.freeze({
    address: "4vGwGztbPUSjBqqjdPtFgaE8DkSU4sDi1dZYTd4bgm1S",
    assetMint: TESTNET_MINTS.aBTC,
    shareMint: TESTNET_MINTS.primeBTC,
  }),
  usdVault: Object.freeze({
    address: "3k868jHNwxYax7WRfyfvTtuZmw1xmrA1GTsYhAojcf9b",
    assetMint: TESTNET_MINTS.aUSD,
    shareMint: TESTNET_MINTS.primeUSD,
  }),
  clamm: Object.freeze({
    address: "4dxf7ekX2G88gDNg84KWqaboynnWNC8QS1sQHkCsBs9i",
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
      programId: "3twt5DX6EuUZ2XpfaZoLQzxdju7879HiiZvVibbbFPh6",
      config: "F2i3GDqySFWxnazfk1zAnS2oANSKKAyGG6fRfeyxYTTJ",
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
