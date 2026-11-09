import { buildRouteGraph, findRoutes, supportedPairs } from "./config/routes.js";
import { NETWORKS, type NetworkConfig, type PropAmmMarket } from "./config/networks.js";
import { MAINNET_DIRECT_RFQ_MARKETS, type DirectRfqMarketDeployment } from "./config/direct-rfq-markets.js";
import { composableDirectRfqSwap } from "./direct-rfq.js";
import { RouterSdkError } from "./errors.js";
import type { RoutedRfqQuoteProvider } from "./propamm.js";
import { quoteCandidates } from "./quote-candidates.js";
import { prepareQuoteState } from "./quote-state.js";
import type { QuoteExactInRequest, QuoteForOutputRequest, RouterClient, RouterClientOptions, RouterSwapQuote } from "./types.js";
import { decodeAddress, deriveAddress, U64_MAX } from "./utils.js";

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

export function createRouterClient({ source, network = "testnet", propAmmQuoteProvider, directRfqQuoteProvider, directRfqDeployment, directRfqMarkets }: RouterClientOptions): RouterClient {
  if (!Object.hasOwn(NETWORKS, network)) {
    throw new RouterSdkError("INVALID_NETWORK", `Unknown network: ${network}.`);
  }
  const original = NETWORKS[network];
  const directProvider = network === "mainnet" ? directRfqQuoteProvider : undefined;
  const isBtcUsd = (market: { baseMint: string; quoteMint: string }) =>
    market.baseMint === original.mints.aBTC && market.quoteMint === original.mints.aUSD;
  let markets: readonly (DirectRfqMarketDeployment & PropAmmMarket & { readonly symbol?: string })[] = [];
  if (network === "mainnet") {
    if (directRfqMarkets === undefined && directRfqDeployment === undefined) {
      markets = MAINNET_DIRECT_RFQ_MARKETS.map(({ id, symbol, deployment }) => ({
        ...deployment, id, symbol, sides: ["buy", "sell"], allowClamm: true,
      }));
    } else {
      const entries = directRfqMarkets ?? [];
      if (entries.length > 0 && directRfqDeployment === undefined) {
        throw new RouterSdkError("INVALID_REQUEST", "Direct RFQ markets require a deployment.");
      }
      if (directRfqDeployment) {
        const { programId, config, quoteSigner, treasuryAuthority, bridgeProgramId } = directRfqDeployment;
        for (const key of [programId, config, quoteSigner]) decodeAddress(key);
        if (treasuryAuthority !== undefined || bridgeProgramId !== undefined) {
          if (treasuryAuthority === undefined || bridgeProgramId === undefined) {
            throw new RouterSdkError("INVALID_REQUEST", "Treasury settings require both identities.");
          }
          decodeAddress(treasuryAuthority);
          decodeAddress(bridgeProgramId);
        }
        markets = entries.map(({ baseMint, quoteMint, sides }, index) => {
          decodeAddress(baseMint);
          decodeAddress(quoteMint);
          if (baseMint === quoteMint) throw new RouterSdkError("INVALID_REQUEST", "Distinct market mints required.");
          if (!Array.isArray(sides) || sides.length === 0 || new Set(sides).size !== sides.length
            || sides.some(side => side !== "buy" && side !== "sell")) {
            throw new RouterSdkError("INVALID_REQUEST", "RFQ markets require distinct supported sides.");
          }
          return { programId, config, quoteSigner,
            ...(treasuryAuthority === undefined ? {} : { treasuryAuthority, bridgeProgramId: bridgeProgramId! }),
            baseMint, quoteMint, sides: [...sides], id: `configured-${index}`,
            baseVault: deriveAddress(programId, "vault", decodeAddress(config), decodeAddress(baseMint)),
            quoteVault: deriveAddress(programId, "vault", decodeAddress(config), decodeAddress(quoteMint)),
            tokenProgramId: original.programs.tokenProgramId,
            associatedTokenProgramId: original.programs.associatedTokenProgramId,
            systemProgramId: original.programs.systemProgramId,
            allowClamm: !isBtcUsd({ baseMint, quoteMint }),
          };
        });
        const pairs = markets.map(market => [market.baseMint, market.quoteMint].sort().join(":"));
        if (new Set(pairs).size !== pairs.length) throw new RouterSdkError("INVALID_REQUEST", "Duplicate direct RFQ market.");
      }
    }
  }
  const builtinIds = new Set<string>(MAINNET_DIRECT_RFQ_MARKETS.map(market => market.id));
  const config: NetworkConfig = { ...original,
    propammMarkets: [...original.propammMarkets.filter(market => !builtinIds.has(market.id)), ...markets],
  };
  const useLegacyBtcUsd = propAmmQuoteProvider !== undefined && !(directProvider && markets.some(isBtcUsd));
  const enabledMarkets = [...(useLegacyBtcUsd ? ["btc-usd"] : []), ...(directProvider ? markets.map(market => market.id) : [])];
  const graph = config ? buildRouteGraph(config, enabledMarkets) : undefined;
  const pairs = graph ? supportedPairs(graph) : [];
  async function quote(request: QuoteExactInRequest | QuoteForOutputRequest, amount: bigint, forOutput: boolean): Promise<RouterSwapQuote> {
    if (!config || !graph) throw new RouterSdkError("NETWORK_NOT_CONFIGURED", `${network} deployment is not configured.`);
    const { inputMint, outputMint, slippageBps, user, deadlineMs } = request;
    validateRequest(request, amount, forOutput);
    const candidates = findRoutes(graph, inputMint, outputMint, { forOutput });
    const directMarket = directProvider && markets.find(market => inputMint === market.baseMint || outputMint === market.baseMint);
    if (!candidates.length) {
      throw new RouterSdkError("UNSUPPORTED_PAIR", forOutput && directMarket
        ? directMarket.symbol ? `${directMarket.symbol}/aUSD supports exact-input quotes only.` : "Direct RFQ markets support exact-input quotes only." : "The requested mint pair is not supported.");
    }
    if (directMarket && deadlineMs <= Date.now()) {
      throw new RouterSdkError("RFQ_EXPIRED", directMarket.symbol ? `Composable ${directMarket.symbol} swap deadline has expired.` : "Direct RFQ swap deadline has expired.");
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
