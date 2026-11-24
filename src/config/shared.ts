export type Network = "testnet" | "mainnet";

/** APL programs shared by the configured testnet and mainnet deployments. */
export const TOKEN_PROGRAMS = Object.freeze({
  tokenProgramId: "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk",
  associatedTokenProgramId: "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3",
  systemProgramId: "11111111111111111111111111111111",
} as const);
