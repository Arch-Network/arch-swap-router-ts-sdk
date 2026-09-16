import { FIXED_ROUTES } from "./config/routes.js";
import { TESTNET_VENUES } from "./config/testnet.js";
import { RouterSdkError } from "./errors.js";
import { loadClamm, prepareClammQuote } from "./clamm.js";
import { buildRouterInstruction } from "./transactions/instructions.js";
import type { QuoteExactInRequest, QuoteForOutputRequest, RouterClient, RouterClientOptions, SwapQuote } from "./types.js";
import { decodeAddress, deriveVaultAddress, inputForOutput, readAccounts, U64_MAX } from "./utils.js";
import { prepareVaultQuote } from "./vault.js";

export function createRouterClient({ source }: RouterClientOptions): RouterClient {
  async function quote(request: QuoteExactInRequest | QuoteForOutputRequest, amount: bigint, forOutput: boolean): Promise<SwapQuote> {
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
    const route = FIXED_ROUTES.find(
      (route) => route.inputMint === inputMint && route.outputMint === outputMint,
    );
    if (!route) {
      throw new RouterSdkError("UNSUPPORTED_PAIR", "The requested mint pair is not supported.");
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    const accounts = await readAccounts(source, route.steps.flatMap((step) => {
      if (step.venue === "clamm") {
        const pool = TESTNET_VENUES.clamm;
        return [pool.address, pool.tokenMintA, pool.tokenMintB];
      }
      const vault = TESTNET_VENUES[step.venue];
      return [vault.address, vault.assetMint, vault.shareMint, deriveVaultAddress("reserve", decodeAddress(vault.shareMint))];
    }));
    const clammStep = route.steps.find((step) => step.venue === "clamm");
    const clamm = clammStep && loadClamm(accounts, clammStep.inputMint === TESTNET_VENUES.clamm.tokenMintA);
    const ticks = clamm && await readAccounts(source, clamm.addresses);
    const hops = route.steps.map((step) => step.venue === "clamm"
      ? prepareClammQuote(clamm!, ticks!)
      : prepareVaultQuote(accounts, TESTNET_VENUES[step.venue], step.operation, now));
    const estimate = (input: bigint) => hops.reduce((value, hop) => hop.estimate(value), input);
    const { amountIn, amountOut } = forOutput
      ? inputForOutput(estimate, amount)
      : { amountIn: amount, amountOut: estimate(amount) };
    const minAmountOut = amountOut * BigInt(10_000 - slippageBps) / 10_000n;
    if (minAmountOut === 0n) {
      throw new RouterSdkError("ZERO_OUTPUT", "Slippage leaves a zero minimum output.");
    }
    return {
      inputMint, outputMint, amountIn, estimatedAmountOut: amountOut, minAmountOut, deadlineMs,
      instructions: [buildRouterInstruction({
        user, inputMint, amountIn, minAmountOut, deadlineMs, steps: hops.map((hop) => hop.resolved),
      })],
    };
  }
  return {
    quoteExactIn: (request) => quote(request, request.amountIn, false),
    quoteForOutput: (request) => quote(request, request.amountOut, true),
  };
}
