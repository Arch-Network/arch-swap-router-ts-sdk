import { MAINNET_MINTS } from "./mainnet-mints.js";
import { MAINNET_RFQ_DEPLOYMENT } from "./rfq-deployment.js";

// Mainnet deployment verified against /markets, a treasury quote and Arch RPC on 2026-11-03.
export const MAINNET_AETH_USD = Object.freeze({
  ...MAINNET_RFQ_DEPLOYMENT,
  baseMint: MAINNET_MINTS.aETH,
  baseDecimals: 9,
  baseVault: "FAuBgc7Uc6nd3sEdmJ3k1B9q3cmeFnDnusKSxgQUTyDF",
} as const);
