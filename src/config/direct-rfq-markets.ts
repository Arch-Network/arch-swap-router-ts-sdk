import { MAINNET_AETH_USD } from "./aeth-usd.js";
import { MAINNET_AHYPE_USD } from "./ahype-usd.js";
import { MAINNET_PRIME_BTC_USD, MAINNET_PRIME_USD_USD } from "./prime-usd.js";
import type { ProgramIds, PropAmmDeployment } from "./networks.js";

export interface DirectRfqMarketDeployment extends PropAmmDeployment,
  Pick<ProgramIds, "tokenProgramId" | "associatedTokenProgramId" | "systemProgramId"> {
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly quoteSigner: string;
  readonly treasuryAuthority?: string;
  readonly bridgeProgramId?: string;
}

/** Trusted SDK markets; the provider supplies quotes for the selected native leg. */
export const MAINNET_DIRECT_RFQ_MARKETS = Object.freeze([
  Object.freeze({
    id: "aeth-usd", symbol: "aETH", deployment: MAINNET_AETH_USD,
    sides: Object.freeze(["sell", "buy"] as const), allowClamm: true,
  }),
  Object.freeze({
    id: "hype-usd", symbol: "aHYPE", deployment: MAINNET_AHYPE_USD,
    sides: Object.freeze(["sell", "buy"] as const), allowClamm: true,
  }),
  Object.freeze({
    id: "prime-btc-usd", symbol: "primeBTC", deployment: MAINNET_PRIME_BTC_USD,
    sides: Object.freeze(["sell"] as const), allowClamm: false,
  }),
  Object.freeze({
    id: "prime-usd-usd", symbol: "primeUSD", deployment: MAINNET_PRIME_USD_USD,
    sides: Object.freeze(["sell"] as const), allowClamm: false,
  }),
] as const);
