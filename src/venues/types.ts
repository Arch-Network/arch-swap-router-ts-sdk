import type { AccountMeta } from "@arch-network/arch-sdk";
import type { StepArgs } from "../codecs/types.js";
import type {
  HopQuote,
  RouteOperation,
  RouteQuote,
  RouteStep,
  RouterDataSource,
  RouterDeployment,
  VenueConfig,
} from "../types.js";

export interface VenueQuoteContext {
  readonly deployment: RouterDeployment;
  readonly source: RouterDataSource;
}

export interface ResolvedHopQuote {
  readonly quote: HopQuote;
  readonly args: StepArgs;
  readonly accounts: readonly AccountMeta[];
}

export interface ResolvedRouteQuote {
  readonly quote: RouteQuote;
  readonly hops: readonly ResolvedHopQuote[];
}

export interface VenueAdapter<TVenue extends VenueConfig> {
  readonly operation: RouteOperation;

  getConnections(venue: TVenue): readonly RouteStep[];

  quoteExactIn(
    venue: TVenue,
    step: RouteStep,
    amountIn: bigint,
    context: VenueQuoteContext,
  ): Promise<ResolvedHopQuote>;
}
