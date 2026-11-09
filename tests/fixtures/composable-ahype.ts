import { vi } from "vitest";
import { createRouterClient, MAINNET_AHYPE_USD as market, type DirectRfqQuote, type QuoteExactInRequest } from "../../src/index.js";
import { NETWORKS } from "../../src/config/networks.js";
import { U64_MAX } from "../../src/utils.js";
import capture from "./ahype-usd/deployment.json" with { type: "json" };
import clock from "./aeth-usd/transactions.json" with { type: "json" };
import { nativeTransaction } from "./aeth-usd/transactions.js";
import { setupComposableAeth, setU64 } from "./composable-aeth.js";

/** Resize captured unsigned server packets; vault/CLAMM state and terms are synthetic. */
export function ahypeQuote(side: "buy" | "sell", amountIn = 1_000_000n, bounded = true, slippageBps = 100): DirectRfqQuote {
  const fixture = capture.cases.find(item => item.side === side)!;
  const transaction = nativeTransaction(fixture.transaction_hex);
  const estimatedAmountOut = amountIn * BigInt(fixture.estimated_amount_out) / BigInt(fixture.amount_in);
  const expiresAtMs = BigInt(clock.now_ms + 30_000);
  if (side === "sell") {
    const data = transaction.message.instructions[0]!.data;
    for (const [offset, amount] of [[2, amountIn], [10, estimatedAmountOut], [18, expiresAtMs], [34, amountIn],
      [42, estimatedAmountOut * BigInt(10_000 - slippageBps) / 10_000n]] as const) setU64(data, offset, amount);
    return { transaction, quoteId: "native-ahype-sell", expiresAtMs, estimatedAmountOut };
  }
  setU64(transaction.message.instructions[0]!.data, 1, amountIn);
  setU64(transaction.message.instructions[1]!.data, 33, estimatedAmountOut);
  const maximum = amountIn * 10050n / 10_000n;
  return { transaction, quoteId: "treasury-ahype-buy", expiresAtMs, estimatedAmountOut,
    treasuryAuthorization: { version: 1,
      minAmountIn: bounded ? (amountIn * 9950n + 9999n) / 10_000n : amountIn,
      maxAmountIn: bounded ? maximum < U64_MAX ? maximum : U64_MAX : amountIn } };
}

/** Native buy mode uses the same 13-account builder layout as the captured sell. */
export function nativeAhypeBuyQuote(amountIn = 1_000_000n, slippageBps = 100): DirectRfqQuote {
  const fixture = capture.cases.find(item => item.side === "sell")!;
  const transaction = nativeTransaction(fixture.transaction_hex);
  const data = transaction.message.instructions[0]!.data;
  const estimatedAmountOut = ahypeQuote("buy", amountIn).estimatedAmountOut;
  const expiresAtMs = BigInt(clock.now_ms + 30_000);
  data[1] = 0;
  for (const [offset, amount] of [[2, estimatedAmountOut], [10, amountIn], [18, expiresAtMs], [34, amountIn],
    [42, estimatedAmountOut * BigInt(10_000 - slippageBps) / 10_000n]] as const) setU64(data, offset, amount);
  return { transaction, quoteId: "native-ahype-buy", expiresAtMs, estimatedAmountOut };
}

export function setupComposableAhype(counterMint: string = market.quoteMint, side: "buy" | "sell" = "sell", bounded = true, nativeBuy = false) {
  const state = setupComposableAeth();
  const request = { ...state.request, inputMint: side === "buy" ? counterMint : market.baseMint,
    outputMint: side === "buy" ? market.baseMint : counterMint,
    amountIn: side === "buy" && counterMint === NETWORKS.mainnet.mints.aBTC ? 1_000n : 1_000_000n };
  const issue = (input: QuoteExactInRequest) => side === "buy" && nativeBuy
    ? nativeAhypeBuyQuote(input.amountIn, input.slippageBps) : ahypeQuote(side, input.amountIn, bounded, input.slippageBps);
  const rfq = issue(request);
  const directRfqQuoteProvider = { quoteExactIn: vi.fn(async (input: QuoteExactInRequest) => issue(input)) };
  const options = { ...state.options, directRfqQuoteProvider };
  return { ...state, request, rfq, directRfqQuoteProvider, options, client: createRouterClient(options) };
}
