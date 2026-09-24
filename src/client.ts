import { fixedRoutes } from "./config/routes.js";
import { NETWORKS, type NetworkConfig } from "./config/networks.js";
import { RouterSdkError } from "./errors.js";
import { loadClamm, prepareClammQuote } from "./clamm.js";
import { quotePropAmm } from "./propamm.js";
import { buildPropAmmInstructions, buildRouterInstruction } from "./transactions/instructions.js";
import type { ResolvedStep } from "./transactions/types.js";
import type { QuoteExactInRequest, QuoteForOutputRequest, RouterClient, RouterClientOptions, SwapQuote } from "./types.js";
import { decodeAddress, deriveAddress, inputForOutput, readAccounts, U64_MAX } from "./utils.js";
import { prepareVaultQuote } from "./vault.js";

export function createRouterClient({ source, network = "testnet", propAmmQuoteProvider }: RouterClientOptions): RouterClient {
  if (!Object.hasOwn(NETWORKS, network)) {
    throw new RouterSdkError("INVALID_NETWORK", `Unknown network: ${network}.`);
  }
  const config: NetworkConfig | null = NETWORKS[network];
  const routes = config ? fixedRoutes(config.mints) : [];
  async function quote(request: QuoteExactInRequest | QuoteForOutputRequest, amount: bigint, forOutput: boolean): Promise<SwapQuote> {
    if (!config) throw new RouterSdkError("NETWORK_NOT_CONFIGURED", `${network} deployment is not configured.`);
    const { programs, venues } = config;
    const { inputMint, outputMint, slippageBps, user, deadlineMs } = request;
    for (const address of [inputMint, outputMint, user]) decodeAddress(address);
    if (typeof amount !== "bigint" || amount <= 0n || amount > U64_MAX) {
      throw new RouterSdkError("INVALID_REQUEST", `${forOutput ? "amountOut" : "amountIn"} must be a positive u64 bigint.`);
    }
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 9999) {
      throw new RouterSdkError("INVALID_REQUEST", "slippageBps must be an integer in 0..9999.");
    }
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
      throw new RouterSdkError("INVALID_REQUEST", "deadlineMs must be a nonnegative safe integer.");
    }
    const route = routes.find(
      (route) => route.inputMint === inputMint && route.outputMint === outputMint,
    );
    if (!route) {
      throw new RouterSdkError("UNSUPPORTED_PAIR", "The requested mint pair is not supported.");
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    const swapIndex = route.steps.findIndex((step) => step.venue === "clamm");
    const clammStep = route.steps[swapIndex];
    const propamm = !forOutput && clammStep && propAmmQuoteProvider ? config.propamm : undefined;
    const pool = venues.clamm;
    if (clammStep && !pool && !propamm) {
      throw new RouterSdkError("NO_ROUTE", forOutput
        ? "Receive sizing for swap routes requires a configured CLAMM pool."
        : "Swap routes on this network require a PropAMM quote provider.");
    }
    const clammKeys = pool ? [pool.address, pool.tokenMintA, pool.tokenMintB] : [];
    const keys = route.steps.flatMap((step) => {
      if (step.venue === "clamm") {
        // With RFQ enabled, isolate pool reads so their failure cannot hide PropAMM.
        return propamm ? [] : clammKeys;
      }
      const vault = venues[step.venue];
      return [vault.address, vault.assetMint, vault.shareMint, deriveAddress(programs.vaultProgramId, "reserve", decodeAddress(vault.shareMint))];
    });
    const accounts = keys.length ? await readAccounts(source, keys) : new Map();
    const vaults = route.steps.map((step) => step.venue === "clamm"
      ? undefined
      : prepareVaultQuote(accounts, venues[step.venue], step.operation, now, programs));
    const swapInput = propamm && swapIndex > 0 ? vaults[0]!.estimate(amount) : amount;
    const buildQuote = (amountIn: bigint, amountsOut: readonly bigint[], steps: readonly ResolvedStep[], effectiveDeadline = deadlineMs, quoteId?: string): SwapQuote => {
      const amountOut = amountsOut[amountsOut.length - 1]!;
      const minAmountOut = amountOut * BigInt(10_000 - slippageBps) / 10_000n;
      if (minAmountOut === 0n) throw new RouterSdkError("ZERO_OUTPUT", "Slippage leaves a zero minimum output.");
      const input = { user, inputMint, amountIn, minAmountOut, deadlineMs: effectiveDeadline, steps };
      return {
        inputMint, outputMint, amountIn, estimatedAmountOut: amountOut, minAmountOut, deadlineMs: effectiveDeadline,
        hops: steps.map((step, i) => ({
          kind: step.kind, inputMint: i === 0 ? inputMint : steps[i - 1]!.outputMint, outputMint: step.outputMint,
          amountIn: i === 0 ? amountIn : amountsOut[i - 1]!, estimatedAmountOut: amountsOut[i]!,
        })),
        instructions: quoteId === undefined ? [buildRouterInstruction(input, programs)] : buildPropAmmInstructions(input, programs),
        ...(quoteId === undefined ? {} : { rfq: { quoteId } }),
      };
    };
    const quoteClamm = async () => {
      let swap;
      if (clammStep) {
        const poolAccounts = propamm
          ? new Map([...accounts, ...await readAccounts(source, clammKeys.filter((key) => !accounts.has(key)))])
          : accounts;
        const clamm = loadClamm(poolAccounts, clammStep.inputMint === pool!.tokenMintA, config);
        swap = prepareClammQuote(clamm, await readAccounts(source, clamm.addresses));
      }
      const hops = vaults.map((vault) => vault ?? swap!);
      const estimate = (input: bigint) => hops.reduce((value, hop) => hop.estimate(value), input);
      const amountIn = forOutput ? inputForOutput(estimate, amount).amountIn : amount;
      let value = amountIn;
      const amountsOut = hops.map((hop, i) => value = propamm && i < swapIndex ? swapInput : hop.estimate(value));
      return buildQuote(amountIn, amountsOut, hops.map((hop) => hop.resolved));
    };
    if (!propamm) return quoteClamm();

    const quoteRfq = async () => {
      const rfq = await quotePropAmm(propAmmQuoteProvider!, {
        inputMint: clammStep!.inputMint, outputMint: clammStep!.outputMint, amountIn: swapInput, user, deadlineMs,
      }, propamm);
      const amountsOut = vaults.map((vault, i) => i < swapIndex ? swapInput
        : vault ? vault.estimate(rfq.estimatedAmountOut) : rfq.estimatedAmountOut);
      return buildQuote(amount, amountsOut, vaults.map((vault) => vault?.resolved ?? rfq.resolved), rfq.deadlineMs, rfq.quoteId);
    };
    const [clamm, rfq] = await Promise.allSettled([pool ? quoteClamm() : undefined, quoteRfq()]);
    const clammQuote = clamm.status === "fulfilled" ? clamm.value : undefined;
    // Pool/tick reads may have outlasted a valid RFQ: check freshness at selection.
    if (rfq.status === "fulfilled" && rfq.value.deadlineMs > Date.now()
      && (!clammQuote || rfq.value.estimatedAmountOut > clammQuote.estimatedAmountOut)) return rfq.value;
    if (clammQuote) return clammQuote;
    throw new RouterSdkError("NO_ROUTE", "No configured venue produced a usable quote.", {
      cause: new AggregateError([
        ...(clamm.status === "rejected" ? [clamm.reason] : []),
        rfq.status === "rejected" ? rfq.reason : new RouterSdkError("RFQ_EXPIRED", "PropAMM quote expired during selection."),
      ]),
    });
  }
  return Object.freeze<RouterClient>({
    network,
    mints: config?.mints ?? null,
    supportedPairs: Object.freeze(routes.map(({ inputMint, outputMint }) => Object.freeze({ inputMint, outputMint }))),
    quoteExactIn: (request) => quote(request, request.amountIn, false),
    quoteForOutput: (request) => quote(request, request.amountOut, true),
  });
}
