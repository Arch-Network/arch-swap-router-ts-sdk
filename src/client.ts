import { buildRouteGraph, findRoutes, supportedPairs } from "./config/routes.js";
import { NETWORKS, type NetworkConfig } from "./config/networks.js";
import { MAINNET_AETH_USD as ethUsd } from "./config/aeth-usd.js";
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

export function createRouterClient({ source, network = "testnet", propAmmQuoteProvider, directRfqQuoteProvider, directRfqDeployment, directRfqMarkets = [] }: RouterClientOptions): RouterClient {
  if (!Object.hasOwn(NETWORKS, network)) {
    throw new RouterSdkError("INVALID_NETWORK", `Unknown network: ${network}.`);
  }
  const original = NETWORKS[network];
  const vaults = [original.venues.btcVault, original.venues.usdVault];
  const isBtcUsd = (market: { baseMint: string; quoteMint: string }) =>
    market.baseMint === original.mints.aBTC && market.quoteMint === original.mints.aUSD;
  if (network === "mainnet" && directRfqMarkets.length > 0 && directRfqDeployment === undefined) {
    throw new RouterSdkError("INVALID_REQUEST", "Direct RFQ markets require a deployment.");
  }
  const deployment = network === "mainnet" ? directRfqDeployment : undefined;
  if (deployment) {
    for (const key of ["programId", "config", "quoteSigner"] as const) decodeAddress(deployment[key]);
    const { treasuryAuthority, bridgeProgramId } = deployment;
    if (treasuryAuthority !== undefined || bridgeProgramId !== undefined) {
      if (treasuryAuthority === undefined || bridgeProgramId === undefined) {
        throw new RouterSdkError("INVALID_REQUEST", "Treasury settings require both identities.");
      }
      decodeAddress(treasuryAuthority);
      decodeAddress(bridgeProgramId);
    }
  }
  const { tokenProgramId, associatedTokenProgramId, systemProgramId } = original.programs;
  const markets = deployment ? directRfqMarkets.map((market, index) => {
    const { baseMint, quoteMint, sides } = market;
    decodeAddress(baseMint);
    decodeAddress(quoteMint);
    if (!Array.isArray(market.sides) || !market.sides.length || new Set(market.sides).size !== market.sides.length
      || market.sides.some(side => side !== "buy" && side !== "sell")) {
      throw new RouterSdkError("INVALID_REQUEST", "RFQ markets require distinct supported sides.");
    }
    if (baseMint === quoteMint) throw new RouterSdkError("INVALID_REQUEST", "Distinct market mints required.");
    return Object.freeze({ ...deployment, baseMint, quoteMint, sides: Object.freeze([...sides]),
      tokenProgramId, associatedTokenProgramId, systemProgramId, id: `configured-${index}`, allowClamm: !isBtcUsd(market) && !vaults.some(vault => vault.shareMint === baseMint && vault.assetMint === quoteMint) });
  }) : [];
  const keys = markets.map(m => [m.baseMint, m.quoteMint].sort().join(":"));
  if (new Set(keys).size !== keys.length) throw new RouterSdkError("INVALID_REQUEST", "Duplicate direct RFQ market.");
  const config: NetworkConfig = { ...original, propammMarkets: [...original.propammMarkets.filter(m => m.id !== "aeth-usd"), ...markets] };
  const directProvider = network === "mainnet" ? directRfqQuoteProvider : undefined;
  const useLegacyBtcUsd = propAmmQuoteProvider !== undefined && !(directProvider && markets.some(isBtcUsd));
  const enabledMarkets = [...(useLegacyBtcUsd ? ["btc-usd"] : []), ...(directProvider ? markets.map(m => m.id) : [])];
  const graph = config ? buildRouteGraph(config, enabledMarkets) : undefined;
  const pairs = graph ? supportedPairs(graph) : [];
  async function quote(request: QuoteExactInRequest | QuoteForOutputRequest, amount: bigint, forOutput: boolean): Promise<RouterSwapQuote> {
    if (!config || !graph) throw new RouterSdkError("NETWORK_NOT_CONFIGURED", `${network} deployment is not configured.`);
    const { inputMint, outputMint, slippageBps, user, deadlineMs } = request;
    validateRequest(request, amount, forOutput);
    const preference = request.routePreference ?? "auto";
    if (!["auto", "vault", "propamm"].includes(preference)) throw new RouterSdkError("INVALID_REQUEST", "Unknown route preference.");
    const sell = markets.some(m => m.sides.includes("sell") && m.baseMint === inputMint && m.quoteMint === outputMint
      && vaults.some(vault => vault.shareMint === inputMint && vault.assetMint === outputMint));
    if (preference !== "auto" && (forOutput || !sell)) throw new RouterSdkError("UNSUPPORTED_PAIR", "Route preference requires a configured exact-input share sell.");
    if (sell && deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Sell deadline has expired.");
    const candidates = findRoutes(graph, inputMint, outputMint, { forOutput }).filter(route => preference === "auto" || (route.steps.length === 1 && (preference === "vault" ? route.steps[0]!.operation === "vaultRedeem" : route.steps[0]!.venue === "propamm")));
    if (!candidates.length) {
      throw new RouterSdkError("UNSUPPORTED_PAIR", forOutput && directProvider && (inputMint === ethUsd.baseMint || outputMint === ethUsd.baseMint)
        ? "aETH/aUSD supports exact-input quotes only." : "The requested mint pair is not supported.");
    }
    if ((inputMint === ethUsd.baseMint || outputMint === ethUsd.baseMint)
      && deadlineMs <= Date.now()) {
      throw new RouterSdkError("RFQ_EXPIRED", "Composable aETH swap deadline has expired.");
    }
    const state = await prepareQuoteState(source, config, candidates);
    const providers = new Map<string, RoutedRfqQuoteProvider>();
    if (useLegacyBtcUsd) providers.set("btc-usd", propAmmQuoteProvider);
    if (directProvider) for (const market of markets) providers.set(market.id, {
      async quoteExactIn(input) {
        const swap = { ...input, slippageBps, deadlineMs };
        return composableDirectRfqSwap(swap, await directProvider.quoteExactIn({ ...swap }), market);
      },
    });
    const result = await quoteCandidates({
      candidates, state, config, request: { inputMint, outputMint, slippageBps, user, deadlineMs },
      amount, forOutput, propAmmQuoteProviders: providers,
    });
    if (sell && result.deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Sell quote expired during selection.");
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
