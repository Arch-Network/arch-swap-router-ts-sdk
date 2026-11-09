import { buildRouteGraph, findRoutes, supportedPairs } from "./config/routes.js";
import { NETWORKS, type NetworkConfig } from "./config/networks.js";
import { MAINNET_DIRECT_RFQ_MARKETS } from "./config/direct-rfq-markets.js";
import { composableDirectRfqSwap } from "./direct-rfq.js";
import { RouterSdkError } from "./errors.js";
import type { RoutedRfqQuoteProvider } from "./propamm.js";
import { quoteCandidates } from "./quote-candidates.js";
import { prepareQuoteState } from "./quote-state.js";
import type { QuoteExactInRequest, QuoteForOutputRequest, RouterClient, RouterClientOptions, RouterSwapQuote } from "./types.js";
import { decodeAddress, U64_MAX } from "./utils.js";

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

export function createRouterClient({ source, network = "testnet", propAmmQuoteProvider, directRfqQuoteProvider }: RouterClientOptions): RouterClient {
  if (!Object.hasOwn(NETWORKS, network)) {
    throw new RouterSdkError("INVALID_NETWORK", `Unknown network: ${network}.`);
  }
  const config: NetworkConfig | null = NETWORKS[network];
  const directProvider = network === "mainnet" ? directRfqQuoteProvider : undefined;
  const directMarkets = directProvider ? MAINNET_DIRECT_RFQ_MARKETS : [];
  const enabledMarkets = [...(propAmmQuoteProvider ? ["btc-usd"] : []), ...directMarkets.map(market => market.id)];
  const graph = config ? buildRouteGraph(config, enabledMarkets) : undefined;
  const pairs = graph ? supportedPairs(graph) : [];
  async function quote(request: QuoteExactInRequest | QuoteForOutputRequest, amount: bigint, forOutput: boolean): Promise<RouterSwapQuote> {
    if (!config || !graph) throw new RouterSdkError("NETWORK_NOT_CONFIGURED", `${network} deployment is not configured.`);
    const { inputMint, outputMint, slippageBps, user, deadlineMs } = request;
    validateRequest(request, amount, forOutput);
    const preference = request.routePreference ?? "auto";
    if (!["auto", "vault", "propamm"].includes(preference)) {
      throw new RouterSdkError("INVALID_REQUEST", "Unknown route preference.");
    }
    const primeSell = network === "mainnet" && outputMint === config.mints.aUSD
      && (inputMint === config.mints.primeBTC || inputMint === config.mints.primeUSD);
    if (preference !== "auto" && (forOutput || !primeSell)) {
      throw new RouterSdkError("UNSUPPORTED_PAIR", "Route preference requires an exact-input Prime sell to aUSD.");
    }
    if (primeSell && deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Sell deadline has expired.");
    const candidates = findRoutes(graph, inputMint, outputMint, { forOutput }).filter(route => {
      if (preference === "auto") return true;
      // primeBTC's vault exit includes a subsequent BTC/USD swap.
      return preference === "vault" ? route.steps[0]!.operation === "vaultRedeem"
        : route.steps.length === 1 && route.steps[0]!.venue === "propamm";
    });
    const directMarket = directMarkets.find(({ deployment }) => inputMint === deployment.baseMint || outputMint === deployment.baseMint);
    if (!candidates.length) {
      throw new RouterSdkError("UNSUPPORTED_PAIR", forOutput && directMarket
        ? `${directMarket.symbol}/aUSD supports exact-input quotes only.` : "The requested mint pair is not supported.");
    }
    if (directMarket && deadlineMs <= Date.now()) {
      throw new RouterSdkError("RFQ_EXPIRED", `Composable ${directMarket.symbol} swap deadline has expired.`);
    }
    const state = await prepareQuoteState(source, config, candidates);
    const providers = new Map<string, RoutedRfqQuoteProvider>();
    if (propAmmQuoteProvider) providers.set("btc-usd", propAmmQuoteProvider);
    if (directProvider) for (const { id, deployment } of directMarkets) providers.set(id, {
      async quoteExactIn(input) {
        const swap = { ...input, slippageBps, deadlineMs };
        return composableDirectRfqSwap(swap, await directProvider.quoteExactIn({ ...swap }), deployment);
      },
    });
    const result = await quoteCandidates({
      candidates, state, config, request: { inputMint, outputMint, slippageBps, user, deadlineMs },
      amount, forOutput, propAmmQuoteProviders: providers,
    });
    if (primeSell && result.deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Sell quote expired during selection.");
    return result;
  }
  return Object.freeze<RouterClient>({
    network,
    mints: config?.mints ?? null,
    supportedPairs: Object.freeze(pairs),
    quoteExactIn: (request) => quote(request, request.amountIn, false),
    quoteForOutput: (request) => quote(request, request.amountOut, true),
  });
}
