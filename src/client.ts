import { FIXED_ROUTES } from "./config/routes.js";
import { TESTNET_VENUES } from "./config/testnet.js";
import { RouterSdkError } from "./errors.js";
import { loadClamm, quoteClamm } from "./clamm.js";
import { buildRouterInstruction } from "./transactions/instructions.js";
import type { ResolvedStep } from "./transactions/types.js";
import type { RouterClient, RouterClientOptions } from "./types.js";
import { decodeAddress, deriveVaultAddress, readAccounts, U64_MAX } from "./utils.js";
import { quoteVault } from "./vault.js";

export function createRouterClient({ source }: RouterClientOptions): RouterClient {
  return {
    async quoteExactIn(request) {
      const { inputMint, outputMint, amountIn, slippageBps, user, deadlineMs } = request;
      for (const address of [inputMint, outputMint, user]) decodeAddress(address);
      if (typeof amountIn !== "bigint" || amountIn <= 0n || amountIn > U64_MAX) {
        throw new RouterSdkError("INVALID_REQUEST", "amountIn must be a positive u64 bigint.");
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
      let amountOut = amountIn;
      const steps: ResolvedStep[] = [];
      for (const step of route.steps) {
        const quote = step.venue === "clamm"
          ? quoteClamm(clamm!, ticks!, amountOut)
          : quoteVault(accounts, TESTNET_VENUES[step.venue], step.operation, amountOut, now);
        amountOut = quote.amountOut;
        steps.push(quote.resolved);
      }
      const minAmountOut = amountOut * BigInt(10_000 - slippageBps) / 10_000n;
      if (minAmountOut === 0n) {
        throw new RouterSdkError("ZERO_OUTPUT", "Slippage leaves a zero minimum output.");
      }
      return {
        inputMint, outputMint, amountIn, estimatedAmountOut: amountOut, minAmountOut, deadlineMs,
        instructions: [buildRouterInstruction({
          user, inputMint, amountIn, minAmountOut, deadlineMs, steps,
        })],
      };
    },
  };
}
