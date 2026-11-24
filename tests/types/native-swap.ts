import {
  attachUserSignature, createSwapClient, type NativeSwapQuote, type SwapClient, type SwapQuoteRequest,
} from "../../src/index.js";

// Compile-only contract: wallet/RPC implementations are supplied by the application.
export async function nativeSwapLifecycle(
  client: SwapClient,
  request: SwapQuoteRequest,
  sign: (quote: NativeSwapQuote) => Promise<Uint8Array>,
) {
  const { tokens, pairs } = await client.getPairs();
  const quote = await client.quote(request);
  const transaction = attachUserSignature(quote, await sign(quote));
  const submission = await client.submit(quote, transaction);
  const attempt = await client.getAttempt(quote.quoteId);
  return { tokens, pairs, output: quote.guaranteedAmountOut, submission, attempt };
}

export function nativeSwapTypes() {
  const client = createSwapClient({ baseUrl: "/api/propamm" });
  // @ts-expect-error Receive sizing is not part of the native API.
  client.quoteForOutput({});
  // @ts-expect-error No frontend account reader or network registry is required.
  createSwapClient({ baseUrl: "/api/propamm", source: { getAccounts: async () => [] } });
  const request: SwapQuoteRequest = { inputMint: "", outputMint: "", user: "", maxAmountIn: 1n };
  // @ts-expect-error Input amounts are raw bigint values, not JS numbers.
  request.maxAmountIn = 1;
  // @ts-expect-error No forced venue selection in the native API.
  client.quote({ ...request, routePreference: "vault" });
}
