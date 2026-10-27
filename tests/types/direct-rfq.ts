import {
  compileRouterMessage,
  createRouterClient,
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
} from "../../src/index.js";

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
  if (quote.execution === "serverTransaction") {
    const server: ServerTransactionSwapQuote = quote;
    const transaction: RuntimeTransaction = server.transaction;
    // @ts-expect-error Server transactions must not expose rebuildable router instructions.
    server.instructions;
    return { message: transaction.message, quoteId: server.rfq.quoteId };
  }
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

export function serverQuoteRequiresId(quote: Omit<ServerTransactionSwapQuote, "rfq">) {
  // @ts-expect-error Every server transaction needs RFQ submission metadata.
  const invalid: SwapQuote = quote;
  return invalid;
}
