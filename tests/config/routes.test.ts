import { describe, expect, it, vi } from "vitest";
import { buildRouteGraph, coreRoutes, findRoutes, supportedPairs, TESTNET_ROUTES, SUPPORTED_PAIRS, type RouteGraph, type RouteStep } from "../../src/config/routes.js";
import { NETWORKS, TESTNET_MINTS, TESTNET_VENUES } from "../../src/config/networks.js";
import { createRouterClient } from "../../src/index.js";
import { namedFixture } from "../transactions/fixtures.js";

const directedFixtures = [
  "direct-mint-btc", "direct-redeem-btc", "direct-mint-usd", "direct-redeem-usd",
  "direct-clamm-btc", "direct-clamm-usd",
  "two-hop-redeem-clamm-btc", "two-hop-clamm-mint-btc",
  "two-hop-redeem-clamm-usd", "two-hop-clamm-mint-usd",
  "three-hop-btc-shared", "three-hop-usd-shared",
];

describe("graph-generated core routes", () => {
  it.each(["testnet", "mainnet"] as const)("uses the selected %s registry for every core path", (network) => {
    const config = NETWORKS[network];
    const routes = coreRoutes(config);
    const replace = new Map(Object.entries(TESTNET_MINTS).map(([name, mint]) => [mint as string, config.mints[name as keyof typeof TESTNET_MINTS]]));
    expect(routes).toHaveLength(12);
    for (const name of directedFixtures) {
      const fixture = namedFixture(name);
      const mints = fixture.mints.map((mint) => replace.get(mint)!);
      const route = routes.find((route) => route.inputMint === mints[0] && route.outputMint === mints.at(-1))!;
      expect(route.steps.map((step) => step.operation)).toEqual(fixture.hops.map((hop) => hop.args.kind));
      expect([route.inputMint, ...route.steps.map((step) => step.outputMint)]).toEqual(mints);
    }
    const deployedMints = new Set<string>(Object.values(config.mints));
    expect(routes.every((route) => route.steps.every((step) => deployedMints.has(step.inputMint)
      && deployedMints.has(step.outputMint)))).toBe(true);
  });

  it("builds edges from venue endpoints rather than assuming the named mint order", () => {
    const config = NETWORKS.testnet;
    const graph = buildRouteGraph({ ...config, venues: {
      ...config.venues,
      btcVault: { ...config.venues.btcVault, assetMint: "asset", shareMint: "share" },
      clamm: { ...config.venues.clamm, tokenMintA: config.mints.aUSD, tokenMintB: "asset" },
    } });
    expect(findRoutes(graph, "share", config.mints.aUSD)[0]!.steps).toMatchObject([
      { venue: "btcVault", operation: "vaultRedeem", inputMint: "share", outputMint: "asset" },
      { venue: "clamm", operation: "clamm", inputMint: "asset", outputMint: config.mints.aUSD },
    ]);
    expect(graph.has(config.mints.aBTC)).toBe(false);
  });

  it("offers each distinct directed pair exactly once", () => {
    const mints = Object.values(TESTNET_MINTS);
    const pairs = SUPPORTED_PAIRS.map((pair) => `${pair.inputMint}:${pair.outputMint}`);
    expect(pairs).toHaveLength(12);
    expect(new Set(pairs).size).toBe(12);
    for (const input of mints) {
      for (const output of mints) {
        expect(pairs.includes(`${input}:${output}`)).toBe(input !== output);
      }
    }
  });

  it.each(directedFixtures)("matches native venue order and mint path: %s", (name) => {
    const fixture = namedFixture(name);
    const route = TESTNET_ROUTES.find(
      (route) => route.inputMint === fixture.mints[0] && route.outputMint === fixture.mints.at(-1),
    )!;
    expect(route).toBeDefined();
    expect(route.steps.map((step) => step.operation)).toEqual(fixture.hops.map((hop) => hop.args.kind));
    expect([route.inputMint, ...route.steps.map((step) => step.outputMint)]).toEqual(fixture.mints);
    expect(route.steps.map((step) => TESTNET_VENUES[step.venue].address)).toEqual(
      fixture.hops.map((hop) => hop.accounts[1]!.pubkey),
    );
    expect(route.steps.length).toBeGreaterThanOrEqual(1);
    expect(route.steps.length).toBeLessThanOrEqual(3);
    expect(new Set(fixture.mints).size).toBe(fixture.mints.length);
    route.steps.forEach((step, index) => expect(step.inputMint).toBe(fixture.mints[index]));
  });

  it("keeps the public pair list immutable and separate from internal steps", () => {
    expect(Object.isFrozen(SUPPORTED_PAIRS)).toBe(true);
    expect(Object.keys(SUPPORTED_PAIRS[0]!)).toEqual(["inputMint", "outputMint"]);
    expect(Reflect.set(SUPPORTED_PAIRS[0]!, "inputMint", "changed")).toBe(false);
    expect(Reflect.set(TESTNET_MINTS, "aBTC", "changed")).toBe(false);
    for (const route of TESTNET_ROUTES) {
      expect(Object.isFrozen(route)).toBe(true);
      expect(Object.isFrozen(route.steps)).toBe(true);
      expect(route.steps.every(Object.isFrozen)).toBe(true);
    }
  });
});

describe("parallel RFQ candidates", () => {
  it.each(["testnet", "mainnet"] as const)("finds both venues without adding pairs on %s", (network) => {
    const config = NETWORKS[network];
    const graph = buildRouteGraph(config, ["btc-usd"]);
    const edges = [...graph.values()].flat();
    expect(edges).toHaveLength(8);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(8);
    expect(buildRouteGraph(config, ["btc-usd"])).toEqual(graph);
    expect(supportedPairs(graph)).toEqual(supportedPairs(buildRouteGraph(config)));
    for (const route of coreRoutes(config)) {
      const candidates = findRoutes(graph, route.inputMint, route.outputMint);
      const swaps = route.steps.some((step) => step.venue === "clamm");
      expect(candidates).toHaveLength(swaps ? 2 : 1);
      expect(candidates[0]).toEqual(route);
      if (swaps) {
        expect(candidates[1]!.steps.map((step) => step.operation)).toEqual(
          route.steps.map((step) => step.operation === "clamm" ? "propamm" : step.operation),
        );
        const rfq = candidates[1]!.steps.find((step) => step.venue === "propamm")!;
        const market = config.propammMarkets[0]!;
        expect(rfq.id).toContain(market.config);
        expect([rfq.inputMint, rfq.outputMint].sort()).toEqual([market.baseMint, market.quoteMint].sort());
      }
      expect(findRoutes(graph, route.inputMint, route.outputMint, { forOutput: true })).toEqual([route]);
      for (const candidate of candidates) {
        const mints = [candidate.inputMint, ...candidate.steps.map((step) => step.outputMint)];
        expect(new Set(mints).size).toBe(mints.length);
        expect(candidate.steps.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it("requires both provider opt-in and a configured deployment", () => {
    const { propammMarkets: _deployments, ...withoutDeployment } = NETWORKS.testnet;
    for (const graph of [buildRouteGraph(NETWORKS.testnet), buildRouteGraph(NETWORKS.testnet, []), buildRouteGraph(withoutDeployment, ["btc-usd"])]) {
      expect([...graph.values()].flat()).toHaveLength(6);
      expect(supportedPairs(graph)).toEqual(SUPPORTED_PAIRS);
    }
  });

  it("constructs client graphs and metadata without account or provider calls", () => {
    const source = { getAccounts: vi.fn(async () => { throw new Error("Unexpected account read"); }) };
    const provider = { quoteExactIn: vi.fn(async () => { throw new Error("Unexpected RFQ"); }) };
    for (const network of ["testnet", "mainnet"] as const) {
      const client = createRouterClient({ network, source, propAmmQuoteProvider: provider, directRfqQuoteProvider: provider });
      expect(client.supportedPairs).toHaveLength(network === "mainnet" ? 20 : 12);
    }
    expect(source.getAccounts).not.toHaveBeenCalled();
    expect(provider.quoteExactIn).not.toHaveBeenCalled();
  });
});

function edge(inputMint: string, outputMint: string, operation: "clamm" | "propamm" = "clamm"): RouteStep {
  const fields = { id: `${operation}:${inputMint}:${outputMint}`, inputMint, outputMint };
  return operation === "propamm" ? { ...fields, venue: "propamm", operation, marketId: "synthetic", allowClamm: true } : { ...fields, venue: "clamm", operation };
}

function graphOf(...edges: RouteStep[]): RouteGraph {
  const graph = new Map<string, RouteStep[]>();
  for (const edge of edges) graph.set(edge.inputMint, [...(graph.get(edge.inputMint) ?? []), edge]);
  return graph;
}

describe("bounded simple-path traversal", () => {
  it.each([
    ["a", "a"], ["missing", "b"], ["a", "missing"], ["c", "a"],
  ])("rejects an identical or unreachable pair %s → %s", (input, output) => {
    expect(findRoutes(graphOf(edge("a", "b"), edge("b", "c")), input, output)).toEqual([]);
  });

  it("rejects cycles and self loops while exploring independent sibling paths", () => {
    const graph = graphOf(edge("a", "a"), edge("a", "b"), edge("b", "a"), edge("b", "c"), edge("a", "d"), edge("d", "c"), edge("c", "b"));
    const routes = findRoutes(graph, "a", "c");
    expect(routes.map((route) => [route.inputMint, ...route.steps.map((step) => step.outputMint)])).toEqual([
      ["a", "b", "c"], ["a", "d", "c"],
    ]);
    expect(findRoutes(graph, "a", "b").map((route) => route.steps.length)).toEqual([1, 3]);
  });

  it("accepts three hops and excludes four-hop reachability from pair metadata", () => {
    const graph = graphOf(edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"));
    expect(findRoutes(graph, "a", "d")[0]!.steps).toHaveLength(3);
    expect(findRoutes(graph, "a", "e")).toEqual([]);
    const pairs = supportedPairs(graph);
    expect(pairs).toContainEqual({ inputMint: "a", outputMint: "d" });
    expect(pairs).not.toContainEqual({ inputMint: "a", outputMint: "e" });
    expect(pairs).toContainEqual({ inputMint: "d", outputMint: "e" });
  });

  it("allows one RFQ at any hop but excludes two-RFQ paths", () => {
    const graph = graphOf(edge("a", "b", "propamm"), edge("b", "c", "propamm"), edge("c", "d"), edge("b", "d"), edge("a", "c"), edge("c", "d", "propamm"));
    expect(findRoutes(graph, "a", "d").map((route) => route.steps.map((step) => step.operation))).toEqual([
      ["propamm", "clamm"], ["clamm", "clamm"], ["clamm", "propamm"],
    ]);
    expect(findRoutes(graphOf(edge("a", "b", "propamm"), edge("b", "c"), edge("c", "d")), "a", "d")).toHaveLength(1);
    expect(findRoutes(graphOf(edge("a", "b"), edge("b", "c", "propamm"), edge("c", "d")), "a", "d")).toHaveLength(1);
    expect(findRoutes(graphOf(edge("a", "b"), edge("b", "c"), edge("c", "d", "propamm")), "a", "d")).toHaveLength(1);
    expect(findRoutes(graph, "a", "d", { forOutput: true }).map((route) => route.steps.map((step) => step.operation))).toEqual([["clamm", "clamm"]]);
    expect(supportedPairs(graphOf(edge("a", "b", "propamm"), edge("b", "c", "propamm"))))
      .not.toContainEqual({ inputMint: "a", outputMint: "c" });
  });

  it("freezes candidate paths and deduplicates frozen metadata across parallel venues", () => {
    const graph = buildRouteGraph(NETWORKS.testnet, ["btc-usd"]);
    const routes = findRoutes(graph, TESTNET_MINTS.primeBTC, TESTNET_MINTS.primeUSD);
    expect(Object.isFrozen(routes)).toBe(true);
    for (const route of routes) {
      expect(Object.isFrozen(route)).toBe(true);
      expect(Object.isFrozen(route.steps)).toBe(true);
      expect(route.steps.every(Object.isFrozen)).toBe(true);
    }
    expect([...graph.values()].every(Object.isFrozen)).toBe(true);
    const pairs = supportedPairs(graph);
    expect(Object.isFrozen(pairs)).toBe(true);
    expect(pairs.every(Object.isFrozen)).toBe(true);
    expect(new Set(pairs.map(({ inputMint, outputMint }) => `${inputMint}:${outputMint}`)).size).toBe(12);
    expect(pairs.every((pair) => Object.keys(pair).join() === "inputMint,outputMint")).toBe(true);
    expect(supportedPairs(new Map())).toEqual([]);
  });
});
