import type { NetworkConfig } from "./config/networks.js";
import type { Route } from "./config/routes.js";
import { RouterSdkError } from "./errors.js";
import { quotePropAmm } from "./propamm.js";
import type { prepareQuoteState } from "./quote-state.js";
import { buildPropAmmInstructions, buildRouterInstruction } from "./transactions/instructions.js";
import { assertMessageLimits } from "./transactions/size.js";
import type { ResolvedStep } from "./transactions/types.js";
import type { PropAmmQuoteProvider, QuoteExactInRequest, RouterSwapQuote } from "./types.js";
import { compileRouterMessage, inputForOutput } from "./utils.js";

interface CandidateQuoteInput {
  readonly candidates: readonly Route[];
  readonly state: Awaited<ReturnType<typeof prepareQuoteState>>;
  readonly config: NetworkConfig;
  readonly request: Omit<QuoteExactInRequest, "amountIn">;
  readonly amount: bigint;
  readonly forOutput: boolean;
  readonly propAmmQuoteProvider?: PropAmmQuoteProvider | undefined;
}

/** Evaluate graph paths against one request's prepared state, then choose a quote. */
export async function quoteCandidates({ candidates, state, config, request, amount, forOutput, propAmmQuoteProvider }: CandidateQuoteInput): Promise<RouterSwapQuote> {
  const { inputMint, outputMint, slippageBps, user, deadlineMs } = request;
  const prefix: { amountOut: bigint; resolved: ResolvedStep }[] = [];
  if (!forOutput && candidates.length > 1) {
    let value = amount;
    for (const [index, step] of candidates[0]!.steps.entries()) {
      if (step.venue === "clamm" || step.venue === "propamm"
        || !candidates.every((route) => route.steps[index]?.id === step.id)) break;
      const vault = state.vault(step);
      value = vault.estimate(value);
      prefix.push({ amountOut: value, resolved: vault.resolved });
    }
  }
  const evaluate = async (route: Route): Promise<RouterSwapQuote> => {
    // Receive sizing loads local estimators once; the search never requests RFQs.
    const localHops = forOutput ? await Promise.all(route.steps.map(async (step) => {
      if (step.venue === "propamm") throw new RouterSdkError("UNSUPPORTED_PAIR", "Receive sizing does not support RFQ paths.");
      return step.venue === "clamm" ? state.clamm(step) : state.vault(step);
    })) : undefined;
    const amountIn = localHops
      ? inputForOutput((input) => localHops.reduce((value, hop) => hop.estimate(value), input), amount).amountIn
      : amount;
    const steps: ResolvedStep[] = [];
    const amountsOut: bigint[] = [];
    let value = amountIn, effectiveDeadline = deadlineMs;
    let quoteId: string | undefined;
    for (const [index, step] of route.steps.entries()) {
      const shared = prefix[index];
      if (shared) {
        value = shared.amountOut;
        steps.push(shared.resolved);
      } else if (step.venue === "propamm") {
        if (!propAmmQuoteProvider || !config.propamm) throw new RouterSdkError("INVALID_RFQ", "PropAMM provider or deployment is unavailable.");
        const rfq = await quotePropAmm(propAmmQuoteProvider, {
          inputMint: step.inputMint, outputMint: step.outputMint, amountIn: value, user, deadlineMs,
        }, config.propamm);
        value = rfq.estimatedAmountOut;
        effectiveDeadline = rfq.deadlineMs;
        quoteId = rfq.quoteId;
        steps.push(rfq.resolved);
      } else {
        const hop = localHops?.[index] ?? (step.venue === "clamm" ? await state.clamm(step) : state.vault(step));
        value = hop.estimate(value);
        steps.push(hop.resolved);
      }
      amountsOut.push(value);
    }
    const minAmountOut = value * BigInt(10_000 - slippageBps) / 10_000n;
    if (minAmountOut === 0n) throw new RouterSdkError("ZERO_OUTPUT", "Slippage leaves a zero minimum output.");
    const input = { user, inputMint, amountIn, minAmountOut, deadlineMs: effectiveDeadline, steps };
    const instructions = quoteId === undefined ? [buildRouterInstruction(input, config.programs)] : buildPropAmmInstructions(input, config.programs);
    // The RFQ builder already checks its complete bundle and signer privileges.
    if (quoteId === undefined) assertMessageLimits(compileRouterMessage(instructions, user, new Uint8Array(32)), "Router transaction");
    return {
      inputMint, outputMint, amountIn, estimatedAmountOut: value, minAmountOut, deadlineMs: effectiveDeadline,
      hops: steps.map((step, index) => ({
        kind: step.kind, inputMint: index === 0 ? inputMint : steps[index - 1]!.outputMint, outputMint: step.outputMint,
        amountIn: index === 0 ? amountIn : amountsOut[index - 1]!, estimatedAmountOut: amountsOut[index]!,
      })),
      instructions,
      ...(quoteId === undefined ? {} : { rfq: { quoteId } }),
    };
  };
  const results = await Promise.allSettled(candidates.map(evaluate));
  let winner: RouterSwapQuote | undefined;
  const failures: unknown[] = [];
  // Account reads may outlast an RFQ; check its effective expiry after all paths settle.
  const selectionTime = results.some((result) => result.status === "fulfilled" && result.value.rfq) ? Date.now() : 0;
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason);
      continue;
    }
    const quote = result.value;
    if (quote.rfq && quote.deadlineMs <= selectionTime) {
      failures.push(new RouterSdkError("RFQ_EXPIRED", "PropAMM quote expired during selection."));
      continue;
    }
    if (!winner) {
      winner = quote;
      continue;
    }
    const rank = forOutput ? quote.amountIn : quote.estimatedAmountOut;
    const best = forOutput ? winner.amountIn : winner.estimatedAmountOut;
    if ((forOutput ? rank < best : rank > best) || (rank === best && winner.rfq && !quote.rfq)) winner = quote;
  }
  if (winner) return winner;
  if (candidates.length === 1) throw failures[0];
  throw new RouterSdkError("NO_ROUTE", "No candidate produced a usable quote.", { cause: new AggregateError(failures) });
}
