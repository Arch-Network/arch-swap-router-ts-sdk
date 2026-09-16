import { NotImplementedError } from "../errors/index.js";
import type {
  QuoteRoutesRequest,
  QuoteRoutesResult,
  RouterClientOptions,
} from "../types.js";

export async function quoteRoutesExactIn(
  _options: RouterClientOptions,
  _request: QuoteRoutesRequest,
): Promise<QuoteRoutesResult> {
  throw new NotImplementedError("quoteRoutesExactIn");
}
