import { FIXED_ROUTES } from "./config/routes.js";
import { NotImplementedError, RouterSdkError } from "./errors.js";
import type { RouterClient, RouterClientOptions } from "./types.js";

export function createRouterClient(_options: RouterClientOptions): RouterClient {
  return {
    async quoteExactIn(request) {
      const route = FIXED_ROUTES.find(
        (route) => route.inputMint === request.inputMint && route.outputMint === request.outputMint,
      );
      if (!route) {
        throw new RouterSdkError("UNSUPPORTED_PAIR", "The requested mint pair is not supported.");
      }
      // Account reads and quote math are the next implementation checkpoint.
      throw new NotImplementedError("quoteExactIn");
    },
  };
}
