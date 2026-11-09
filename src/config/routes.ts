import type { Address } from "../types.js";
import { NETWORKS, type NetworkConfig } from "./networks.js";

interface Edge {
  readonly id: string;
  readonly inputMint: Address;
  readonly outputMint: Address;
}

export type CoreRouteStep = Edge & (
  | { readonly venue: "btcVault" | "usdVault"; readonly operation: "vaultMint" | "vaultRedeem" }
  | { readonly venue: "clamm"; readonly operation: "clamm" }
);
export type RouteStep = CoreRouteStep | (Edge & {
  readonly venue: "propamm";
  readonly operation: "propamm";
  readonly marketId: string;
  readonly allowClamm: boolean;
});
export type RouteGraph<Step extends RouteStep = RouteStep> = ReadonlyMap<Address, readonly Step[]>;
export interface Route<Step extends RouteStep = RouteStep> {
  readonly inputMint: Address;
  readonly outputMint: Address;
  readonly steps: readonly Step[];
}

const MAX_HOPS = 3;

/** Internal deployment graph. RFQ edges require explicit provider opt-in. No reads. */
export function buildRouteGraph(config: NetworkConfig): RouteGraph<CoreRouteStep>;
export function buildRouteGraph(config: NetworkConfig, enabledMarkets: readonly string[]): RouteGraph;
export function buildRouteGraph({ venues, propammMarkets }: NetworkConfig, enabledMarkets: readonly string[] = []): RouteGraph {
  const edges: RouteStep[] = [];
  for (const venue of ["btcVault", "usdVault"] as const) {
    const { address, assetMint, shareMint } = venues[venue];
    edges.push(
      { id: `${venue}:${address}:mint`, venue, operation: "vaultMint", inputMint: assetMint, outputMint: shareMint },
      { id: `${venue}:${address}:redeem`, venue, operation: "vaultRedeem", inputMint: shareMint, outputMint: assetMint },
    );
  }
  const pool = venues.clamm;
  edges.push(
    { id: `clamm:${pool.address}:aToB`, venue: "clamm", operation: "clamm", inputMint: pool.tokenMintA, outputMint: pool.tokenMintB },
    { id: `clamm:${pool.address}:bToA`, venue: "clamm", operation: "clamm", inputMint: pool.tokenMintB, outputMint: pool.tokenMintA },
  );
  for (const market of propammMarkets ?? []) {
    if (!enabledMarkets.includes(market.id)) continue;
    for (const side of market.sides) edges.push({
      id: `propamm:${market.programId}:${market.config}:${market.baseMint}:${market.quoteMint}:${side}`,
      venue: "propamm", operation: "propamm", marketId: market.id, allowClamm: market.allowClamm,
      inputMint: side === "sell" ? market.baseMint : market.quoteMint,
      outputMint: side === "sell" ? market.quoteMint : market.baseMint,
    });
  }
  const adjacency = new Map<Address, RouteStep[]>();
  for (const edge of edges) {
    const outgoing = adjacency.get(edge.inputMint) ?? [];
    outgoing.push(Object.freeze(edge));
    adjacency.set(edge.inputMint, outgoing);
  }
  return new Map([...adjacency].map(([mint, outgoing]) => [mint, Object.freeze(outgoing)]));
}

/** Depth-first simple paths from one mint, in registry order (CLAMM before RFQ). */
function walkRoutes<Step extends RouteStep>(
  graph: RouteGraph<Step>, inputMint: Address, forOutput: boolean,
  outputMint: Address | undefined, emit: (route: Route<Step>) => void,
): void {
  const steps: Step[] = [];
  const visited = new Set([inputMint]);
  const visit = (mint: Address, hasRfq: boolean): void => {
    if (steps.length === MAX_HOPS) return;
    for (const edge of graph.get(mint) ?? []) {
      const rfq = edge.operation === "propamm";
      if (visited.has(edge.outputMint) || (rfq && (forOutput || hasRfq))) continue;
      if ((rfq && !edge.allowClamm && steps.some((step) => step.operation === "clamm"))
        || (edge.operation === "clamm" && steps.some((step) => step.operation === "propamm" && !step.allowClamm))) continue;
      steps.push(edge);
      if (outputMint === undefined || edge.outputMint === outputMint) {
        emit(Object.freeze({ inputMint, outputMint: edge.outputMint, steps: Object.freeze([...steps]) }));
      }
      // A targeted search stops at its output; a full search keeps extending the path.
      if (edge.outputMint !== outputMint) {
        visited.add(edge.outputMint);
        visit(edge.outputMint, hasRfq || rfq);
        visited.delete(edge.outputMint);
      }
      steps.pop();
    }
  };
  visit(inputMint, false);
}

/** Enumerate simple executable paths, keeping registry order (CLAMM before RFQ). */
export function findRoutes<Step extends RouteStep>(
  graph: RouteGraph<Step>, inputMint: Address, outputMint: Address,
  { forOutput = false }: { readonly forOutput?: boolean } = {},
): readonly Route<Step>[] {
  const routes: Route<Step>[] = [];
  if (inputMint !== outputMint) walkRoutes(graph, inputMint, forOutput, outputMint, (route) => routes.push(route));
  return Object.freeze(routes);
}

/** Every exact-input route, grouped by pair in mint-registry order. One search per input mint. */
function routesByPair<Step extends RouteStep>(graph: RouteGraph<Step>): readonly (readonly Route<Step>[])[] {
  const mints = [...new Set([...graph.values()].flatMap((edges) => edges.flatMap((edge) => [edge.inputMint, edge.outputMint])))];
  const groups: (readonly Route<Step>[])[] = [];
  for (const inputMint of mints) {
    const byOutput = new Map<Address, Route<Step>[]>();
    walkRoutes(graph, inputMint, false, undefined, (route) => {
      const routes = byOutput.get(route.outputMint) ?? [];
      routes.push(route);
      byOutput.set(route.outputMint, routes);
    });
    for (const outputMint of mints) {
      const routes = byOutput.get(outputMint);
      if (routes) groups.push(Object.freeze(routes));
    }
  }
  return groups;
}

const pairsOf = (groups: readonly (readonly Route[])[]) =>
  Object.freeze(groups.map(([route]) => Object.freeze({ inputMint: route!.inputMint, outputMint: route!.outputMint })));

/** Reachability metadata, independent of account state and deduplicated across venues. */
export function supportedPairs(graph: RouteGraph) {
  return pairsOf(routesByPair(graph));
}

/** All non-RFQ paths for the selected deployment, generated without a pair table. */
export function coreRoutes(config: NetworkConfig): readonly Route<CoreRouteStep>[] {
  return Object.freeze(routesByPair(buildRouteGraph(config)).flat());
}

const TESTNET_ROUTE_GROUPS = routesByPair(buildRouteGraph(NETWORKS.testnet));
/** Testnet metadata retained for existing callers; the graph remains package-internal. */
export const TESTNET_ROUTES = Object.freeze(TESTNET_ROUTE_GROUPS.flat());
export const SUPPORTED_PAIRS = pairsOf(TESTNET_ROUTE_GROUPS);
