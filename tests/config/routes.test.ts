import { describe, expect, it } from "vitest";
import { fixedRoutes, FIXED_ROUTES, SUPPORTED_PAIRS } from "../../src/config/routes.js";
import { TESTNET_MINTS, TESTNET_VENUES } from "../../src/config/networks.js";
import { namedFixture } from "../transactions/fixtures.js";

const directedFixtures = [
  "direct-mint-btc", "direct-redeem-btc", "direct-mint-usd", "direct-redeem-usd",
  "direct-clamm-btc", "direct-clamm-usd",
  "two-hop-redeem-clamm-btc", "two-hop-clamm-mint-btc",
  "two-hop-redeem-clamm-usd", "two-hop-clamm-mint-usd",
  "three-hop-btc-shared", "three-hop-usd-shared",
];

describe("fixed testnet routes", () => {
  it("uses selected mints throughout the same fixed paths", () => {
    const mints = { aBTC: "btc", aUSD: "usd", primeBTC: "prime-btc", primeUSD: "prime-usd" };
    const replace = new Map(Object.entries(TESTNET_MINTS).map(([name, address]) => [address as string, mints[name as keyof typeof mints]]));
    expect(fixedRoutes(mints)).toEqual(FIXED_ROUTES.map((route) => ({
      inputMint: replace.get(route.inputMint), outputMint: replace.get(route.outputMint),
      steps: route.steps.map((step) => ({ ...step, inputMint: replace.get(step.inputMint), outputMint: replace.get(step.outputMint) })),
    })));
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
    const route = FIXED_ROUTES.find(
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
    for (const route of FIXED_ROUTES) {
      expect(Object.isFrozen(route.steps)).toBe(true);
      expect(route.steps.every(Object.isFrozen)).toBe(true);
    }
  });
});
