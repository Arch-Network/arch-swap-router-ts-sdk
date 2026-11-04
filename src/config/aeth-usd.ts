import { MAINNET, MAINNET_AETH_MINT, MAINNET_MINTS, MAINNET_RFQ_DEPLOYMENT } from "./networks.js";

// Mainnet deployment verified against /markets, a treasury quote and Arch RPC on 2026-11-03.
export const MAINNET_AETH_USD = Object.freeze({
  ...MAINNET_RFQ_DEPLOYMENT,
  sides: Object.freeze(["buy", "sell"] as const),
  baseMint: MAINNET_AETH_MINT,
  baseDecimals: 9,
  quoteMint: MAINNET_MINTS.aUSD,
  quoteDecimals: 6,
  baseVault: "FAuBgc7Uc6nd3sEdmJ3k1B9q3cmeFnDnusKSxgQUTyDF",
  quoteVault: "F49WGwEHaHhq4SDpkTGX3mwpMw6axmVdLv6c7gVPXbFL",
  tokenProgramId: MAINNET.tokenProgramId,
  associatedTokenProgramId: MAINNET.associatedTokenProgramId,
  systemProgramId: MAINNET.systemProgramId,
} as const);
