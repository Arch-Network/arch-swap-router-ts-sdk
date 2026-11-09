import { MAINNET_RFQ_DEPLOYMENT } from "./rfq-deployment.js";

// Mainnet market and native/treasury quote identities checked on 2026-11-09.
export const MAINNET_AHYPE_USD = Object.freeze({
  ...MAINNET_RFQ_DEPLOYMENT,
  baseMint: "e1nbE9knw6fS1TwDixC3ZuXhDJpBf874WErswvqvMes",
  baseDecimals: 9,
  baseVault: "Aqk5wABc2xUcaxeW2943Tjd3uUGvRN2M91DvcRw4pexy",
} as const);
