import { NotImplementedError } from "../errors/index.js";
import type { QuotedSwap } from "../types.js";

export function rankAndLimitQuotes(
  _quotes: readonly QuotedSwap[],
  _limit: number,
): readonly QuotedSwap[] {
  throw new NotImplementedError("rankAndLimitQuotes");
}
