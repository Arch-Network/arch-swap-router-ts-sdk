import { NotImplementedError } from "../errors/index.js";
import type { Address, RoutePlan, VenueConfig } from "../types.js";

export function discoverRoutes(
  _venues: readonly VenueConfig[],
  _inputMint: Address,
  _outputMint: Address,
): readonly RoutePlan[] {
  throw new NotImplementedError("discoverRoutes");
}
