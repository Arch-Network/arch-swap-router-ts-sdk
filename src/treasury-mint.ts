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
export function resolveTreasuryMint(quote: TreasuryMintQuote, deployment: PropAmmDeployment, inputMint: string, outputMint: string): ResolvedStep {
  const { treasuryAuthority, bridgeProgramId } = deployment;
  if (!treasuryAuthority || !bridgeProgramId) {
    throw new RouterSdkError("INVALID_RFQ", "Treasury execution is not configured for this market.");
  }
  return {
    kind: "treasuryMint", outputMint,
    terms: { ...quote.terms, issuanceId: quote.terms.issuanceId.slice() },
    bridgeProgramId, treasuryAuthority,
    bridgeConfig: deriveAddress(bridgeProgramId, "config"),
    assetConfig: deriveAddress(bridgeProgramId, "asset", decodeAddress(outputMint)),
    issuanceReceipt: deriveAddress(bridgeProgramId, "treasury_mint", quote.terms.issuanceId),
    mintAuthority: deriveAddress(bridgeProgramId, "mint-authority", decodeAddress(outputMint)),
    propammConfig: deployment.config,
    paymentVault: deriveAddress(deployment.programId, "vault", decodeAddress(deployment.config), decodeAddress(inputMint)),
  };
}
