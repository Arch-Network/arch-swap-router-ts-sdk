import type { Instruction } from "@arch-network/arch-sdk";
import { NotImplementedError } from "../errors/index.js";
import type { QuoteRoutesRequest, RouterDeployment } from "../types.js";
import type { ResolvedRouteQuote } from "../venues/types.js";

export function buildInstructionBundle(
  _quote: ResolvedRouteQuote,
  _request: QuoteRoutesRequest,
  _deployment: RouterDeployment,
): readonly Instruction[] {
  throw new NotImplementedError("buildInstructionBundle");
}
