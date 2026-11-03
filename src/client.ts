import { buildRouteGraph, findRoutes, supportedPairs } from "./config/routes.js";
import { NETWORKS, type NetworkConfig } from "./config/networks.js";
import { MAINNET_AETH_USD as ethUsd } from "./config/aeth-usd.js";
import { composableAethSwap } from "./direct-rfq.js";
import { RouterSdkError } from "./errors.js";
import { quoteCandidates } from "./quote-candidates.js";
import { prepareQuoteState } from "./quote-state.js";
import type { PropAmmQuoteProvider, QuoteExactInRequest, QuoteForOutputRequest, RouterClient, RouterClientOptions, RouterSwapQuote } from "./types.js";
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
  const enabledMarkets = [...(propAmmQuoteProvider ? ["btc-usd"] : []), ...(directProvider ? ["aeth-usd"] : [])];
  const graph = config ? buildRouteGraph(config, enabledMarkets) : undefined;
  const pairs = graph ? supportedPairs(graph) : [];
  async function quote(request: QuoteExactInRequest | QuoteForOutputRequest, amount: bigint, forOutput: boolean): Promise<RouterSwapQuote> {
    if (!config || !graph) throw new RouterSdkError("NETWORK_NOT_CONFIGURED", `${network} deployment is not configured.`);
    const { inputMint, outputMint, slippageBps, user, deadlineMs } = request;
    validateRequest(request, amount, forOutput);
    const candidates = findRoutes(graph, inputMint, outputMint, { forOutput });
    if (!candidates.length) {
      throw new RouterSdkError("UNSUPPORTED_PAIR", forOutput && directProvider && (inputMint === ethUsd.baseMint || outputMint === ethUsd.baseMint)
        ? "aETH/aUSD supports exact-input quotes only." : "The requested mint pair is not supported.");
    }
    if ((inputMint === ethUsd.baseMint || outputMint === ethUsd.baseMint)
      && deadlineMs <= Date.now()) {
      throw new RouterSdkError("RFQ_EXPIRED", "Composable aETH swap deadline has expired.");
    }
    const state = await prepareQuoteState(source, config, candidates);
    const providers = new Map<string, PropAmmQuoteProvider>();
    if (propAmmQuoteProvider) providers.set("btc-usd", propAmmQuoteProvider);
    if (directProvider) providers.set("aeth-usd", {
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
  return Object.freeze<RouterClient>({
    network,
    mints: config?.mints ?? null,
    supportedPairs: Object.freeze(pairs),
    quoteExactIn: (request) => quote(request, request.amountIn, false),
    quoteForOutput: (request) => quote(request, request.amountOut, true),
  });
}
