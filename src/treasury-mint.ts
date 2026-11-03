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
  const trusted = deployment.treasuryAuthority && deployment.bridgeProgramId ? deployment : market;
  if (deployment.programId !== trusted.programId || deployment.config !== trusted.config
    || deployment.baseMint !== trusted.baseMint || deployment.quoteMint !== trusted.quoteMint) {
    throw new RouterSdkError("INVALID_RFQ", "Treasury quote does not match the aETH deployment.");
  }
  return {
    kind: "treasuryMint", outputMint: deployment.baseMint,
    terms: { ...quote.terms, issuanceId: quote.terms.issuanceId.slice() },
    bridgeProgramId: trusted.bridgeProgramId!, treasuryAuthority: trusted.treasuryAuthority!,
    bridgeConfig: deriveAddress(trusted.bridgeProgramId!, "config"),
    assetConfig: deriveAddress(trusted.bridgeProgramId!, "asset", decodeAddress(deployment.baseMint)),
    issuanceReceipt: deriveAddress(trusted.bridgeProgramId!, "treasury_mint", quote.terms.issuanceId),
    mintAuthority: deriveAddress(trusted.bridgeProgramId!, "mint-authority", decodeAddress(deployment.baseMint)),
    propammConfig: deployment.config,
    paymentVault: deriveAddress(deployment.programId, "vault", decodeAddress(deployment.config), decodeAddress(deployment.quoteMint)),
  };
}
