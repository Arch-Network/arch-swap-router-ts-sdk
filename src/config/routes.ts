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

/** Enumerate simple executable paths, keeping registry order (CLAMM before RFQ). */
export function findRoutes<Step extends RouteStep>(
  graph: RouteGraph<Step>, inputMint: Address, outputMint: Address,
  { forOutput = false }: { readonly forOutput?: boolean } = {},
): readonly Route<Step>[] {
  const routes: Route<Step>[] = [];
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
      if (edge.outputMint === outputMint) {
        routes.push(Object.freeze({ inputMint, outputMint, steps: Object.freeze([...steps]) }));
      } else {
        visited.add(edge.outputMint);
        visit(edge.outputMint, hasRfq || rfq);
        visited.delete(edge.outputMint);
      }
      steps.pop();
    }
  };
  if (inputMint !== outputMint) visit(inputMint, false);
  return Object.freeze(routes);
}

/** Reachability metadata, independent of account state and deduplicated across venues. */
export function supportedPairs(graph: RouteGraph) {
  const mints = new Set([...graph.values()].flatMap((edges) => edges.flatMap((edge) => [edge.inputMint, edge.outputMint])));
  const pairs: { readonly inputMint: Address; readonly outputMint: Address }[] = [];
  for (const inputMint of mints) {
    for (const outputMint of mints) {
      if (findRoutes(graph, inputMint, outputMint).length) pairs.push(Object.freeze({ inputMint, outputMint }));
    }
  }
  return Object.freeze(pairs);
}

/** All non-RFQ paths for the selected deployment, generated without a pair table. */
export function coreRoutes(config: NetworkConfig): readonly Route<CoreRouteStep>[] {
  const graph = buildRouteGraph(config);
  return Object.freeze(supportedPairs(graph).flatMap(({ inputMint, outputMint }) => findRoutes(graph, inputMint, outputMint)));
}

/** Testnet metadata retained for existing callers; the graph remains package-internal. */
export const TESTNET_ROUTES = coreRoutes(NETWORKS.testnet);
export const SUPPORTED_PAIRS = supportedPairs(buildRouteGraph(NETWORKS.testnet));
