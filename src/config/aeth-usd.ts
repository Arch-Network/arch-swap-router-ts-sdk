import { MAINNET_RFQ_DEPLOYMENT } from "./rfq-deployment.js";

// Mainnet deployment verified against /markets, a treasury quote and Arch RPC on 2026-11-03.
export const MAINNET_AETH_USD = Object.freeze({
  ...MAINNET_RFQ_DEPLOYMENT,
  baseMint: "7g1nPCjKW7zzZ4q7mcABeFXaPSLfBQ6syrz4HnPGAVYt",
  baseDecimals: 9,
  baseVault: "FAuBgc7Uc6nd3sEdmJ3k1B9q3cmeFnDnusKSxgQUTyDF",
} as const);
