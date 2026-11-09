import {
  compileRouterMessage,
  createRouterClient,
  MAINNET_AHYPE_USD,
  type DirectRfqQuote,
  type DirectRfqQuoteProvider,
  type PropAmmQuoteProvider,
  type QuoteExactInRequest,
  type QuoteForOutputRequest,
  type RouterClient,
  type RouterClientOptions,
  type RouterDataSource,
  type RouterSwapQuote,
  type RuntimeTransaction,
  type ServerTransactionSwapQuote,
  type SwapQuote,
  type TreasuryAuthorization,
  type TreasuryMintTerms,
} from "../../src/index.js";

export async function quoteHype(client: RouterClient, user: string): Promise<RouterSwapQuote> {
  return client.quoteExactIn({ inputMint: MAINNET_AHYPE_USD.quoteMint, outputMint: MAINNET_AHYPE_USD.baseMint,
    amountIn: 1_000_000n, slippageBps: 100, user, deadlineMs: Date.now() + 30_000 });
}

// Checked by tsc only; no wallet, server or transaction execution.
export function clientWithProviders(source: RouterDataSource, transaction: RuntimeTransaction, propAmmQuoteProvider: PropAmmQuoteProvider): RouterClient {
  const directRfqQuoteProvider: DirectRfqQuoteProvider = {
    async quoteExactIn(request) {
      const input: QuoteExactInRequest = request;
      return {
        transaction,
        quoteId: "issued-quote",
        expiresAtMs: BigInt(input.deadlineMs),
        estimatedAmountOut: input.amountIn,
      };
    },
  };
  const options: RouterClientOptions = { source, network: "mainnet", propAmmQuoteProvider, directRfqQuoteProvider };
  return createRouterClient(options);
}

export async function consumeQuote(client: RouterClient, request: QuoteExactInRequest) {
  const quote = await client.quoteExactIn(request);
  const router: RouterSwapQuote = quote;
  // @ts-expect-error Router quotes contain instructions rather than a server transaction.
  router.transaction;
  return { message: compileRouterMessage(router.instructions, request.user, new Uint8Array(32)), quoteId: router.rfq?.quoteId };
}

export function existingRouterShape(quote: Omit<RouterSwapQuote, "execution">): SwapQuote {
  return quote;
}

export function serverResponseShape(base: Omit<RouterSwapQuote, "execution" | "instructions" | "rfq">, reply: DirectRfqQuote): SwapQuote {
  return {
    ...base,
    execution: "serverTransaction",
    transaction: reply.transaction,
    rfq: { quoteId: reply.quoteId },
  };
}

export async function receiveQuoteRemainsRouter(client: RouterClient, request: QuoteForOutputRequest) {
  const quote: RouterSwapQuote = await client.quoteForOutput(request);
  return quote.instructions;
}

export function clientWithNativeAethSwaps(source: RouterDataSource, directRfqQuoteProvider: DirectRfqQuoteProvider): RouterClient {
  const options: RouterClientOptions = { source, network: "mainnet", directRfqQuoteProvider };
  // @ts-expect-error Composable sells are always enabled with the mainnet provider.
  const invalidSells: RouterClientOptions = { ...options, composableAethSells: false };
  // @ts-expect-error Composable buys are always enabled with the mainnet provider.
  const invalidBuys: RouterClientOptions = { ...options, composableAethBuys: false };
  void invalidSells; void invalidBuys;
  return createRouterClient(options);
}

export function serverQuoteRequiresId(quote: Omit<ServerTransactionSwapQuote, "rfq">) {
  // @ts-expect-error Every server transaction needs RFQ submission metadata.
  const invalid: SwapQuote = quote;
  return invalid;
}

export function boundedTreasuryResponse(quote: DirectRfqQuote): DirectRfqQuote {
  const treasuryAuthorization: TreasuryAuthorization = { version: 1, minAmountIn: 995n, maxAmountIn: 1005n };
  // @ts-expect-error HTTP decimal strings must be decoded before entering the SDK.
  const invalid: TreasuryAuthorization = { version: 1, minAmountIn: "995", maxAmountIn: "1005" };
  const terms: TreasuryMintTerms = { issuanceId: new Uint8Array(32), quotedInput: 1000n,
    quotedOutput: 500n, minInput: treasuryAuthorization.minAmountIn, maxInput: treasuryAuthorization.maxAmountIn,
    expiryMs: quote.expiresAtMs };
  void invalid; void terms;
  return { ...quote, treasuryAuthorization };
}
