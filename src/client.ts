import { buildRouteGraph, findRoutes, supportedPairs } from "./config/routes.js";
import { NETWORKS, type NetworkConfig } from "./config/networks.js";
import { MAINNET_AETH_USD as ethUsd } from "./config/aeth-usd.js";
import { composableAethSwap, normalizeAethUsdBuy, normalizeAethUsdSell } from "./direct-rfq.js";
import { RouterSdkError } from "./errors.js";
import { quoteCandidates } from "./quote-candidates.js";
import { prepareQuoteState } from "./quote-state.js";
import type { DirectRfqQuote, PropAmmQuoteProvider, QuoteExactInRequest, QuoteForOutputRequest, RouterClient, RouterClientOptions, RouterSwapQuote, SwapQuote } from "./types.js";
import { decodeAddress, U64_MAX } from "./utils.js";

function isAethUsdPair(inputMint: string, outputMint: string): boolean {
  return (inputMint === ethUsd.quoteMint && outputMint === ethUsd.baseMint)
    || (inputMint === ethUsd.baseMint && outputMint === ethUsd.quoteMint);
}

function validateRequest(request: QuoteExactInRequest | QuoteForOutputRequest, amount: bigint, forOutput: boolean): void {
  for (const address of [request.inputMint, request.outputMint, request.user]) decodeAddress(address);
  if (typeof amount !== "bigint" || amount <= 0n || amount > U64_MAX) {
    throw new RouterSdkError("INVALID_REQUEST", `${forOutput ? "amountOut" : "amountIn"} must be a positive u64 bigint.`);
  }
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 9999) {
    throw new RouterSdkError("INVALID_REQUEST", "slippageBps must be an integer in 0..9999.");
  }
  if (!Number.isSafeInteger(request.deadlineMs) || request.deadlineMs < 0) {
    throw new RouterSdkError("INVALID_REQUEST", "deadlineMs must be a nonnegative safe integer.");
  }
}

export function createRouterClient({ source, network = "testnet", propAmmQuoteProvider, directRfqQuoteProvider, composableAethSells = false, composableAethBuys = false }: RouterClientOptions): RouterClient {
  if (!Object.hasOwn(NETWORKS, network)) {
    throw new RouterSdkError("INVALID_NETWORK", `Unknown network: ${network}.`);
  }
  const config: NetworkConfig | null = NETWORKS[network];
  const directProvider = network === "mainnet" ? directRfqQuoteProvider : undefined;
  if ((composableAethSells || composableAethBuys) && !directProvider) {
    throw new RouterSdkError("INVALID_REQUEST", "Composable aETH swaps require a mainnet directRfqQuoteProvider.");
  }
  const enabledMarkets = [...(propAmmQuoteProvider ? ["btc-usd"] : []), ...(composableAethSells || composableAethBuys ? ["aeth-usd"] : [])];
  // Keep the fixed registry immutable; each direction has an independent opt-in.
  const graph = config ? buildRouteGraph({ ...config, propammMarkets: (config.propammMarkets ?? []).map(market =>
    market.id === "aeth-usd" ? { ...market, sides: market.sides.filter(side => side === "buy" ? composableAethBuys : composableAethSells) } : market),
  }, enabledMarkets) : undefined;
  const pairs = graph ? supportedPairs(graph) : [];
  const directPairs = directProvider ? [
    { inputMint: ethUsd.quoteMint, outputMint: ethUsd.baseMint },
    { inputMint: ethUsd.baseMint, outputMint: ethUsd.quoteMint },
  ] : [];
  async function quote(request: QuoteExactInRequest | QuoteForOutputRequest, amount: bigint, forOutput: boolean): Promise<RouterSwapQuote> {
    if (!config || !graph) throw new RouterSdkError("NETWORK_NOT_CONFIGURED", `${network} deployment is not configured.`);
    const { inputMint, outputMint, slippageBps, user, deadlineMs } = request;
    validateRequest(request, amount, forOutput);
    const candidates = findRoutes(graph, inputMint, outputMint, { forOutput });
    if (!candidates.length) {
      throw new RouterSdkError("UNSUPPORTED_PAIR", forOutput && directProvider && isAethUsdPair(inputMint, outputMint)
        ? "aETH/aUSD supports exact-input quotes only." : "The requested mint pair is not supported.");
    }
    if (((composableAethSells && inputMint === ethUsd.baseMint) || (composableAethBuys && outputMint === ethUsd.baseMint))
      && deadlineMs <= Date.now()) {
      throw new RouterSdkError("RFQ_EXPIRED", "Composable aETH swap deadline has expired.");
    }
    const state = await prepareQuoteState(source, config, candidates);
    const providers = new Map<string, PropAmmQuoteProvider>();
    if (propAmmQuoteProvider) providers.set("btc-usd", propAmmQuoteProvider);
    if ((composableAethSells || composableAethBuys) && directProvider) providers.set("aeth-usd", {
      async quoteExactIn(input) {
        const swap = { ...input, slippageBps, deadlineMs };
        return composableAethSwap(swap, await directProvider.quoteExactIn({ ...swap }));
      },
    });
    return quoteCandidates({
      candidates, state, config, request: { inputMint, outputMint, slippageBps, user, deadlineMs },
      amount, forOutput, propAmmQuoteProviders: providers,
    });
  }
  async function quoteExactIn(request: QuoteExactInRequest): Promise<SwapQuote> {
    if (!directProvider || !isAethUsdPair(request.inputMint, request.outputMint)
      || (composableAethSells && request.inputMint === ethUsd.baseMint)
      || (composableAethBuys && request.outputMint === ethUsd.baseMint)) return quote(request, request.amountIn, false);
    // Keep the validated request stable across the provider's asynchronous call.
    const input = { ...request };
    validateRequest(input, input.amountIn, false);
    if (input.deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Direct RFQ quote deadline has expired.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rfq: DirectRfqQuote;
    try {
      rfq = await Promise.race([
        Promise.resolve().then(() => directProvider.quoteExactIn({ ...input })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RouterSdkError("RFQ_TIMEOUT", "Direct RFQ quote exceeded 2 seconds.")), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return input.inputMint === ethUsd.quoteMint ? normalizeAethUsdBuy(input, rfq) : normalizeAethUsdSell(input, rfq);
  }

  return Object.freeze<RouterClient>({
    network,
    mints: config?.mints ?? null,
    supportedPairs: Object.freeze([...new Map([...pairs, ...directPairs].map((pair) =>
      [`${pair.inputMint}:${pair.outputMint}`, Object.freeze(pair)] as const)).values()]),
    quoteExactIn,
    quoteForOutput: (request) => quote(request, request.amountOut, true),
  });
}
