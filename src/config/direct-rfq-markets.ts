import { MAINNET_AETH_USD } from "./aeth-usd.js";
import { MAINNET_AHYPE_USD } from "./ahype-usd.js";
import type { ProgramIds, PropAmmDeployment } from "./networks.js";

export interface DirectRfqMarketDeployment extends PropAmmDeployment,
  Pick<ProgramIds, "tokenProgramId" | "associatedTokenProgramId" | "systemProgramId"> {
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly quoteSigner: string;
  readonly treasuryAuthority: string;
  readonly bridgeProgramId: string;
}

/** Trusted SDK markets; the provider supplies quotes for the selected native leg. */
export const MAINNET_DIRECT_RFQ_MARKETS = Object.freeze([
  Object.freeze({ id: "aeth-usd", symbol: "aETH", deployment: MAINNET_AETH_USD }),
  Object.freeze({ id: "hype-usd", symbol: "aHYPE", deployment: MAINNET_AHYPE_USD }),
] as const);
