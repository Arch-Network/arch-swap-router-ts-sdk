import { quoteRoutesExactIn } from "./quotes/quote-routes.js";
import type { RouterClient, RouterClientOptions } from "./types.js";

export function createRouterClient(options: RouterClientOptions): RouterClient {
  return {
    quoteRoutesExactIn(request) {
      return quoteRoutesExactIn(options, request);
    },
  };
}
