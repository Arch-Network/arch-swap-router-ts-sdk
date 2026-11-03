import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKS, TESTNET_MINTS as mints, TESTNET_VENUES as venues } from "../src/config/networks.js";
import { loadClamm } from "../src/clamm.js";
import { buildRouteGraph, findRoutes, type CoreRouteStep, type Route } from "../src/config/routes.js";
import { prepareQuoteState } from "../src/quote-state.js";
import { decodeAddress, deriveAddress } from "../src/utils.js";
import { now, setup } from "./fixtures/quotes.js";

const config = NETWORKS.testnet;
const graph = buildRouteGraph(config, ["btc-usd"]);
const setU64 = (data: Uint8Array, offset: number, value: bigint) => new DataView(data.buffer).setBigUint64(offset, value, true);

type VaultStep = Exclude<CoreRouteStep, { readonly venue: "clamm" }>;
function vaultStep(route: Route, venue: VaultStep["venue"]): VaultStep {
  return route.steps.find((step): step is VaultStep => step.venue === venue)!;
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Number(now) * 1000); });
afterEach(() => { vi.restoreAllMocks(); });

describe("request-local quote preparation", () => {
  it("loads only the requested vault even with RFQ edges enabled", async () => {
    const { source } = setup();
    await prepareQuoteState(source, config, findRoutes(graph, mints.aBTC, mints.primeBTC));
    expect(source.getAccounts.mock.calls).toEqual([[[
      venues.btcVault.address, mints.aBTC, mints.primeBTC,
      deriveAddress(config.programs.vaultProgramId, "reserve", decodeAddress(mints.primeBTC)),
    ]]]);
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it("shares decoded vaults between candidates and refreshes their mutable supply on the next request", async () => {
    const { source, accounts } = setup();
    const candidates = findRoutes(graph, mints.primeBTC, mints.primeUSD);
    const state = await prepareQuoteState(source, config, candidates);
    const suffix = vaultStep(candidates[0]!, "usdVault");
    const parallelSuffix = vaultStep(candidates[1]!, "usdVault");
    const vault = state.vault(suffix);
    expect(state.vault(parallelSuffix)).toBe(vault);
    const before = vault.estimate(1_000n);
    setU64(accounts.get(mints.primeUSD)!.data, 36, 2_000_000_000_000n);
    expect(state.vault(suffix).estimate(1_000n)).toBe(before);
    const next = await prepareQuoteState(source, config, candidates);
    expect(next.vault(suffix)).not.toBe(vault);
    expect(next.vault(suffix).estimate(1_000n)).toBeGreaterThan(before);
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
    expect(source.getAccounts.mock.calls.every(([keys]) => keys.length === 9 && keys.includes(venues.clamm.address))).toBe(true);
  });

  it("shares concurrent CLAMM preparation after batching all known accounts", async () => {
    const { source, accounts } = setup();
    const candidates = findRoutes(graph, mints.primeBTC, mints.primeUSD);
    const state = await prepareQuoteState(source, config, candidates);
    const swap = candidates[0]!.steps.find((step) => step.venue === "clamm")!;
    let release!: () => void;
    let signalRead!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { signalRead = resolve; });
    source.getAccounts.mockImplementationOnce(async (keys) => {
      signalRead();
      await gate;
      return keys.map((key) => accounts.get(key) ?? null);
    });
    const first = state.clamm(swap);
    const second = state.clamm(swap);
    expect(second).toBe(first);
    await started;
    expect(source.getAccounts.mock.calls[0]![0]).toHaveLength(9);
    expect(source.getAccounts.mock.calls[1]![0]).toEqual(loadClamm(accounts, true, config).addresses);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.estimate(1_000n)).toBeGreaterThan(0n);
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
    const keys = source.getAccounts.mock.calls.flatMap(([keys]) => keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeLessThanOrEqual(12);
  });

  it("memoizes a CLAMM failure without discarding shared vault quotes or retrying", async () => {
    const { source } = setup();
    const candidates = findRoutes(graph, mints.primeBTC, mints.primeUSD);
    const state = await prepareQuoteState(source, config, candidates);
    const swap = candidates[0]!.steps.find((step) => step.venue === "clamm")!;
    const redeem = vaultStep(candidates[0]!, "btcVault");
    const error = new Error("Tick transport failure");
    source.getAccounts.mockRejectedValueOnce(error);
    await expect(state.clamm(swap)).rejects.toBe(error);
    await expect(state.clamm(swap)).rejects.toBe(error);
    expect(state.vault(redeem).estimate(1_000_000n)).toBeGreaterThan(0n);
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
    const next = await prepareQuoteState(source, config, candidates);
    expect((await next.clamm(swap)).estimate(1_000n)).toBeGreaterThan(0n);
    expect(source.getAccounts).toHaveBeenCalledTimes(4);
  });

  it.each(["transport", "framing"])("uses the second read only to recover shared vaults after a batch %s failure", async (failure) => {
    const { source } = setup();
    const candidates = findRoutes(graph, mints.primeBTC, mints.primeUSD);
    const error = new Error("Initial batch unavailable");
    if (failure === "transport") source.getAccounts.mockRejectedValueOnce(error);
    else source.getAccounts.mockResolvedValueOnce([]);
    const state = await prepareQuoteState(source, config, candidates);
    const swap = candidates[0]!.steps.find((step) => step.venue === "clamm")!;
    const redeem = vaultStep(candidates[0]!, "btcVault");
    expect(state.vault(redeem).estimate(1_000_000n)).toBeGreaterThan(0n);
    expect(source.getAccounts.mock.calls.map(([keys]) => keys.length)).toEqual([9, 8]);
    expect(source.getAccounts.mock.calls[1]![0]).not.toContain(venues.clamm.address);
    const rejected: unknown = await state.clamm(swap).catch((error: unknown) => error);
    if (failure === "transport") expect(rejected).toBe(error);
    else expect(rejected).toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(state.clamm(swap)).rejects.toBe(rejected);
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
  });

  it("captures one vault timestamp before reads and applies it to both shared vaults", async () => {
    const { source, accounts } = setup();
    const candidates = findRoutes(graph, mints.primeBTC, mints.primeUSD);
    source.getAccounts.mockImplementationOnce(async (keys) => {
      vi.mocked(Date.now).mockReturnValue(Number(now + 1_000_000n) * 1000);
      return keys.map((key) => accounts.get(key) ?? null);
    });
    const state = await prepareQuoteState(source, config, candidates);
    const suffix = vaultStep(candidates[0]!, "usdVault");
    const prefix = vaultStep(candidates[0]!, "btcVault");
    expect(state.vault(suffix).estimate(state.vault(prefix).estimate(1_000_000n))).toBeGreaterThan(0n);
    expect(Date.now).toHaveBeenCalledTimes(1);
  });
});
