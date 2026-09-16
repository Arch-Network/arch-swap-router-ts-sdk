import { clammAdapter } from "./clamm.js";
import { vaultMintAdapter } from "./vault-mint.js";
import { vaultRedeemAdapter } from "./vault-redeem.js";

export const VENUE_ADAPTERS = [
  vaultMintAdapter,
  vaultRedeemAdapter,
  clammAdapter,
] as const;
