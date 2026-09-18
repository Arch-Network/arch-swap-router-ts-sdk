import type { PropAmmDeployment } from "./config/networks.js";
import { RouterSdkError } from "./errors.js";
import type { ResolvedStep } from "./transactions/types.js";
import type { PropAmmQuote, PropAmmQuoteProvider, QuoteExactInRequest } from "./types.js";
import { decodeAddress, deriveAddress, U64_MAX } from "./utils.js";

/** One bounded RFQ; the application owns HTTP transport and precision-safe decoding. */
export async function quotePropAmm(
  provider: PropAmmQuoteProvider,
  request: Pick<QuoteExactInRequest, "inputMint" | "outputMint" | "amountIn" | "user" | "deadlineMs">,
  deployment: PropAmmDeployment,
) {
  const { inputMint, outputMint, amountIn, user } = request;
  if (request.deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "PropAMM quote deadline has expired.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quote: PropAmmQuote;
  try {
    quote = await Promise.race([
      Promise.resolve().then(() => provider.quoteExactIn({ inputMint, outputMint, amountIn, user })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RouterSdkError("RFQ_TIMEOUT", "PropAMM quote exceeded 2 seconds.")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const terms = quote?.terms;
  const buy = inputMint === deployment.quoteMint && outputMint === deployment.baseMint;
  const sell = inputMint === deployment.baseMint && outputMint === deployment.quoteMint;
  if ((!buy && !sell) || terms?.side !== (buy ? "buy" : "sell")
    || typeof quote?.quoteId !== "string" || !quote.quoteId.trim()) {
    throw new RouterSdkError("INVALID_RFQ", "PropAMM quote ID or direction is invalid.");
  }
  for (const [field, value] of Object.entries({
    baseAmount: terms.baseAmount, quoteAmount: terms.quoteAmount, expiryMs: terms.expiryMs,
    nonce: terms.nonce, estimatedAmountOut: quote.estimatedAmountOut,
  })) {
    if (typeof value !== "bigint" || value < (field === "nonce" ? 0n : 1n) || value > U64_MAX) {
      throw new RouterSdkError("INVALID_RFQ", `PropAMM ${field} must be a ${field === "nonce" ? "nonnegative" : "positive"} u64 bigint.`);
    }
  }
  if ((buy ? terms.quoteAmount : terms.baseAmount) !== amountIn) {
    throw new RouterSdkError("INVALID_RFQ", "PropAMM quoted input does not match the swap input.");
  }
  // request.deadlineMs was validated as a safe integer; the minimum also fits.
  const deadlineMs = Number(terms.expiryMs < BigInt(request.deadlineMs) ? terms.expiryMs : BigInt(request.deadlineMs));
  if (deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "PropAMM quote deadline has expired.");
  const maker = decodeAddress(deployment.maker);
  const resolved: ResolvedStep = {
    kind: "propamm", outputMint, terms: { ...terms },
    programId: deployment.programId, config: deployment.config, maker: deployment.maker,
    userNonce: deriveAddress(deployment.programId, "user_nonce", decodeAddress(deployment.config), decodeAddress(user)),
    baseVault: deriveAddress(deployment.programId, "vault", decodeAddress(deployment.baseMint), maker),
    quoteVault: deriveAddress(deployment.programId, "vault", decodeAddress(deployment.quoteMint), maker),
  };
  return { quoteId: quote.quoteId, estimatedAmountOut: quote.estimatedAmountOut, deadlineMs, resolved };
}
