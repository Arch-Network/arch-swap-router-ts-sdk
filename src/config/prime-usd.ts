import { MAINNET_MINTS } from "./mainnet-mints.js";
import { MAINNET_RFQ_DEPLOYMENT } from "./rfq-deployment.js";

// /markets, /health and unsigned sell quotes checked on 2026-11-09.
// Both deployed Prime markets settle in aUSD. Prime buys use a different ABI
// and remain outside the native inventory sell integration.
const { treasuryAuthority: _treasury, bridgeProgramId: _bridge, ...inventory } = MAINNET_RFQ_DEPLOYMENT;

export const MAINNET_PRIME_BTC_USD = Object.freeze({
  ...inventory,
  baseMint: MAINNET_MINTS.primeBTC,
  baseDecimals: 8,
  baseVault: "5E6Dd3HcQoD6zQHbrCpVAXBYQ4W1hzw2tzyiFu1tqdqx",
} as const);

export const MAINNET_PRIME_USD_USD = Object.freeze({
  ...inventory,
  baseMint: MAINNET_MINTS.primeUSD,
  baseDecimals: 6,
  baseVault: "28nmA1gp11VBdmbzdrGTNHe7h2Yo5PagxeJvV6vSC6P9",
} as const);
