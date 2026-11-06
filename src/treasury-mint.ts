import type { PropAmmDeployment } from "./config/networks.js";
import { MAINNET_AETH_USD as market } from "./config/aeth-usd.js";
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
export function resolveTreasuryMint(quote: TreasuryMintQuote, deployment: PropAmmDeployment): ResolvedStep {
  if (deployment.programId !== market.programId || deployment.config !== market.config
    || deployment.baseMint !== market.baseMint || deployment.quoteMint !== market.quoteMint) {
    throw new RouterSdkError("INVALID_RFQ", "Treasury quote does not match the aETH deployment.");
  }
  return {
    kind: "treasuryMint", outputMint: deployment.baseMint,
    terms: { ...quote.terms, issuanceId: quote.terms.issuanceId.slice() },
    bridgeProgramId: market.bridgeProgramId, treasuryAuthority: market.treasuryAuthority,
    bridgeConfig: deriveAddress(market.bridgeProgramId, "config"),
    assetConfig: deriveAddress(market.bridgeProgramId, "asset", decodeAddress(deployment.baseMint)),
    issuanceReceipt: deriveAddress(market.bridgeProgramId, "treasury_mint", quote.terms.issuanceId),
    mintAuthority: deriveAddress(market.bridgeProgramId, "mint-authority", decodeAddress(deployment.baseMint)),
    propammConfig: deployment.config,
    paymentVault: deriveAddress(deployment.programId, "vault", decodeAddress(deployment.config), decodeAddress(deployment.quoteMint)),
  };
}
