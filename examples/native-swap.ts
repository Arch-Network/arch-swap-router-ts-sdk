import {
  attachUserSignature, SwapSdkError,
  type NativeSwapQuote, type RuntimeTransaction, type SwapClient,
  type SwapQuoteRequest, type SwapRequestOptions,
} from "../src/index.js";

/** Application callbacks; the SDK does not import a wallet or confirmation client. */
export interface NativeSwapExampleCallbacks {
  /** Show maximum spend, guaranteed output, unused input, and intermediate leftovers. */
  reviewQuote(quote: NativeSwapQuote): Promise<void>;
  signMessage(message: RuntimeTransaction["message"]): Promise<Uint8Array>;
  /** Resolve only on confirmed execution success; reject failure or uncertainty. */
  confirm(transactionHash: string): Promise<void>;
}

export async function executeNativeSwapExample(
  client: SwapClient,
  request: SwapQuoteRequest,
  callbacks: NativeSwapExampleCallbacks,
  options?: SwapRequestOptions,
): Promise<{ quote: NativeSwapQuote; transactionHash: string }> {
  const quote = await client.quote(request, options);
  await callbacks.reviewQuote(quote);
  if (Date.now() >= quote.expiresAtMs) throw new SwapSdkError("QUOTE_EXPIRED", "Refresh the quote before opening the wallet.");
  const signature = await callbacks.signMessage(quote.transaction.message);
  // Both helpers recheck freshness and the unchanged message after the wallet prompt.
  const transaction = attachUserSignature(quote, signature);
  const { transactionHash } = await client.submit(quote, transaction, options);
  await callbacks.confirm(transactionHash);
  return { quote, transactionHash };
}
