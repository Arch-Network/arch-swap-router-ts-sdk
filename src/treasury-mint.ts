import type { PropAmmDeployment } from "./config/networks.js";
import { RouterSdkError } from "./errors.js";
import type { ResolvedStep } from "./transactions/types.js";
import type { TreasuryMintTerms } from "./types.js";
import { decodeAddress, deriveAddress } from "./utils.js";

/** Produced only after validating the original payment/mint packet and metadata. */
export interface TreasuryMintQuote {
  readonly kind: "treasuryMint";
  readonly quoteId: string;
  readonly estimatedAmountOut: bigint;
  readonly terms: TreasuryMintTerms;
}

/** Canonical addresses are derived locally; treasury routing adds no account read. */
export function resolveTreasuryMint(quote: TreasuryMintQuote, market: PropAmmDeployment): ResolvedStep {
  if (!market.treasuryAuthority || !market.bridgeProgramId) {
    throw new RouterSdkError("INVALID_RFQ", "Treasury execution is not configured for this market.");
  }
  return {
    kind: "treasuryMint", outputMint: market.baseMint,
    terms: { ...quote.terms, issuanceId: quote.terms.issuanceId.slice() },
    bridgeProgramId: market.bridgeProgramId, treasuryAuthority: market.treasuryAuthority,
    bridgeConfig: deriveAddress(market.bridgeProgramId, "config"),
    assetConfig: deriveAddress(market.bridgeProgramId, "asset", decodeAddress(market.baseMint)),
    issuanceReceipt: deriveAddress(market.bridgeProgramId, "treasury_mint", quote.terms.issuanceId),
    mintAuthority: deriveAddress(market.bridgeProgramId, "mint-authority", decodeAddress(market.baseMint)),
    propammConfig: market.config,
    paymentVault: deriveAddress(market.programId, "vault", decodeAddress(market.config), decodeAddress(market.quoteMint)),
  };
}
