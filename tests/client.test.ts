import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouterClient, SUPPORTED_PAIRS, TESTNET_MINTS } from "../src/index.js";
import { MAINNET, MAINNET_MINTS, MAINNET_VENUES, NETWORKS, TESTNET } from "../src/config/networks.js";
import { decodeAddress, deriveAddress } from "../src/utils.js";
import type { Network } from "../src/index.js";
import type { QuoteExactInRequest, QuoteForOutputRequest } from "../src/types.js";
import { now, setup } from "./fixtures/quotes.js";
import native from "./fixtures/clamm/native.json" with { type: "json" };
// Snapshot of arch-swap-router/deployments/mainnet.json, verified against RPC on 2026-09-28.
import production from "./fixtures/mainnet.json" with { type: "json" };

const source = () => ({ getAccounts: vi.fn(async () => { throw new Error("Unexpected read"); }) });
const request = {
  inputMint: TESTNET_MINTS.aBTC,
  outputMint: TESTNET_MINTS.aUSD,
  amountIn: 1_000n,
  slippageBps: 50,
  user: "Gezw1yUcDjFhKQoJw6zq7nRJTc1MKhcUipNsUfrVpJKF",
  deadlineMs: 1_800_000_000_123,
};

afterEach(() => { vi.restoreAllMocks(); });

describe("compact router client", () => {
  it.each([undefined, "testnet"] as const)("exposes testnet metadata for network %s", (network) => {
    const router = createRouterClient({ source: source(), ...(network && { network }) });
    expect(router.network).toBe("testnet");
    expect(router.mints).toEqual(TESTNET_MINTS);
    expect(router.supportedPairs).toEqual(SUPPORTED_PAIRS);
    expect(Reflect.set(router, "network", "mainnet")).toBe(false);
    expect(Reflect.set(router.mints!, "aBTC", "changed")).toBe(false);
    expect(Object.isFrozen(router.supportedPairs)).toBe(true);
    expect(router.supportedPairs.every(Object.isFrozen)).toBe(true);
  });

  it("uses mainnet deployments and propagates account failures", async () => {
    const reader = source();
    const router = createRouterClient({ source: reader, network: "mainnet" });
    expect(router.network).toBe("mainnet");
    expect(router.mints).toEqual(MAINNET_MINTS);
    expect(router.supportedPairs).toHaveLength(12);
    expect(router.supportedPairs).toContainEqual({ inputMint: MAINNET_MINTS.aBTC, outputMint: MAINNET_MINTS.aUSD });
    const input = { ...request, inputMint: MAINNET_MINTS.aBTC, outputMint: MAINNET_MINTS.primeBTC };
    await expect(router.quoteExactIn(input)).rejects.toThrow("Unexpected read");
    await expect(router.quoteForOutput({ ...input, amountOut: 1000n })).rejects.toThrow("Unexpected read");
    const keys = [MAINNET_VENUES.btcVault.address, MAINNET_MINTS.aBTC, MAINNET_MINTS.primeBTC,
      deriveAddress(MAINNET.vaultProgramId, "reserve", decodeAddress(MAINNET_MINTS.primeBTC))];
    expect(reader.getAccounts.mock.calls).toEqual([[keys], [keys]]);
    expect(createRouterClient({ source: reader }).supportedPairs).toEqual(SUPPORTED_PAIRS);
  });

  it("keeps mainnet addresses valid, distinct and internally consistent", () => {
    const addresses = [...Object.values(MAINNET), ...Object.values(MAINNET_MINTS),
      ...Object.values(MAINNET_VENUES).flatMap(venue => venue ? [venue.address] : [])];
    for (const address of addresses) expect(decodeAddress(address)).toHaveLength(32);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(MAINNET_VENUES.btcVault).toMatchObject({ assetMint: MAINNET_MINTS.aBTC, shareMint: MAINNET_MINTS.primeBTC });
    expect(MAINNET_VENUES.usdVault).toMatchObject({ assetMint: MAINNET_MINTS.aUSD, shareMint: MAINNET_MINTS.primeUSD });
    expect(MAINNET_VENUES.clamm).toMatchObject({ tokenMintA: MAINNET_MINTS.aUSD, tokenMintB: MAINNET_MINTS.aBTC });
    for (const mint of Object.values(MAINNET_MINTS)) expect(Object.values(TESTNET_MINTS)).not.toContain(mint);
  });

  it("matches the native production deployment and its canonical vault addresses", () => {
    expect(MAINNET.routerProgramId).toBe(production.router_program);
    expect(MAINNET.vaultProgramId).toBe(production.vault_program);
    expect(NETWORKS.mainnet.propamm.programId).toBe(production.propamm_program);
    expect(MAINNET.clammProgramId).toBe(production.clamm_program);
    expect(NETWORKS.mainnet.propamm.config).toBe(production.propamm_config);
    expect(MAINNET_VENUES.clamm).toEqual({ address: production.clamm.address,
      tokenMintA: production.clamm.token_mint_a, tokenMintB: production.clamm.token_mint_b });
    expect(Object.values(MAINNET_MINTS).sort()).toEqual(production.vaults.flatMap(v => [v.asset.mint, v.share.mint]).sort());
    for (const [i, venue] of [MAINNET_VENUES.btcVault, MAINNET_VENUES.usdVault].entries()) {
      const vault = production.vaults[i]!;
      expect(venue).toEqual({ address: vault.address, assetMint: vault.asset.mint, shareMint: vault.share.mint });
      expect(deriveAddress(MAINNET.vaultProgramId, "vault", decodeAddress(venue.shareMint))).toBe(vault.address);
    }
  });

  const reverseSymbols = { aBTC: "aUSD", aUSD: "aBTC", primeBTC: "primeUSD", primeUSD: "primeBTC" } as const;
  const mainnetRoutes = native.routes.map(route => ({ ...route,
    input: reverseSymbols[route.input as keyof typeof reverseSymbols],
    output: reverseSymbols[route.output as keyof typeof reverseSymbols],
  }));
  it.each(mainnetRoutes)("quotes production $input → $output in either sizing mode", async (expected) => {
    vi.spyOn(Date, "now").mockReturnValue(Number(now) * 1000);
    const { client, source, request, accounts } = setup(undefined, "mainnet");
    const input = {
      ...request, inputMint: MAINNET_MINTS[expected.input as keyof typeof MAINNET_MINTS],
      outputMint: MAINNET_MINTS[expected.output as keyof typeof MAINNET_MINTS],
    };
    const quote = await client.quoteExactIn(input);
    expect(quote).toMatchObject({ estimatedAmountOut: BigInt(expected.amountOut), minAmountOut: BigInt(expected.minAmountOut) });
    expect(quote.instructions).toHaveLength(1);
    expect(quote.instructions[0]!.program_id).toEqual(decodeAddress(MAINNET.routerProgramId));
    expect(quote.hops.map(hop => hop.estimatedAmountOut)).toEqual(expected.hops.map(BigInt));
    const hasSwap = quote.hops.some(hop => hop.kind === "clamm");
    const keys = quote.instructions[0]!.accounts.map(account => account.pubkey);
    if (hasSwap) {
      expect(keys).toContainEqual(decodeAddress(MAINNET.clammProgramId));
      expect(keys).toContainEqual(decodeAddress(production.clamm.address));
      expect(keys).toContainEqual(decodeAddress(production.clamm.token_vault_a));
      expect(keys).toContainEqual(decodeAddress(production.clamm.token_vault_b));
    }
    if (quote.hops.some(hop => hop.kind.startsWith("vault"))) {
      expect(keys).toContainEqual(decodeAddress(production.vault_program));
    }
    expect(quote.rfq).toBeUndefined();
    const receive = await client.quoteForOutput({ ...input, amountOut: BigInt(expected.amountOut) });
    expect(receive.estimatedAmountOut).toBeGreaterThanOrEqual(BigInt(expected.amountOut));
    expect(receive.amountIn).toBeLessThanOrEqual(input.amountIn);
    expect(source.getAccounts).toHaveBeenCalledTimes(hasSwap ? 4 : 2); // Two quotes, shared batches.
    const callsPerQuote = hasSwap ? 2 : 1;
    for (let i = 0; i < source.getAccounts.mock.calls.length; i += callsPerQuote) {
      const readKeys = source.getAccounts.mock.calls.slice(i, i + callsPerQuote).flatMap(([keys]) => keys);
      expect(new Set(readKeys).size).toBe(readKeys.length);
    }
    for (const vault of production.vaults) for (const token of [vault.asset, vault.share]) {
      expect(accounts.get(token.mint)!.data[44]).toBe(token.decimals);
    }
  });

  it.each(["quoteExactIn", "quoteForOutput"] as const)("rejects retired mock mints and testnet mints in mainnet %s before reads", async (method) => {
    const reader = source();
    const client = createRouterClient({ source: reader, network: "mainnet" });
    const retiredMints = [
      "34hfkQLEgde9PnXsZsvLF2C3dHfAMk6W37T38pouGfWt", "DxPxKTwCmbo9cSB7PURCEz7XtC9ujNmBpZ2A9vKeUzjb",
      "6zNA6ZSagjn4ti3Vwu1ep3d5aMEFWsXecn4Biy1H9JYr", "AB362tcseFQ5prM14MUid3q8w5KwyJ13ToS2174BD95P",
    ];
    for (const mint of [...retiredMints, ...Object.values(TESTNET_MINTS)]) {
      for (const pair of [{ inputMint: mint, outputMint: MAINNET_MINTS.primeUSD },
        { inputMint: MAINNET_MINTS.primeUSD, outputMint: mint }]) {
        await expect(client[method]({ ...request, ...pair, amountOut: 1000n }))
          .rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
      }
    }
    expect(reader.getAccounts).not.toHaveBeenCalled();
  });

  it.each(["devnet", "toString", "", null])("rejects unknown network %s without falling back", (network) => {
    const reader = source();
    expect(() => createRouterClient({ source: reader, network: network as Network }))
      .toThrow(expect.objectContaining({ code: "INVALID_NETWORK" }));
    expect(reader.getAccounts).not.toHaveBeenCalled();
  });

  it.each([0n, -1n, 1n << 64n, 1000, undefined])("rejects invalid receive amount %s before reads", async (amountOut) => {
    const reader = source();
    await expect(createRouterClient({ source: reader }).quoteForOutput({ ...request, amountOut } as QuoteForOutputRequest))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(reader.getAccounts).not.toHaveBeenCalled();
  });

  it.each([
    { amountIn: 0n }, { amountIn: -1n }, { amountIn: 1n << 64n }, { amountIn: 1000 },
    { slippageBps: -1 }, { slippageBps: 10_000 }, { slippageBps: 0.5 },
    { slippageBps: NaN }, { slippageBps: Infinity }, { slippageBps: "50" },
    { deadlineMs: -1 }, { deadlineMs: 0.1 }, { deadlineMs: Number.MAX_SAFE_INTEGER + 1 },
    { deadlineMs: NaN }, { deadlineMs: Infinity }, { deadlineMs: 1n },
    { inputMint: "invalid" }, { outputMint: "111" }, { user: "" }, { user: 42 },
  ])("rejects invalid request %# before reads", async (invalid) => {
    const reader = source();
    await expect(createRouterClient({ source: reader }).quoteExactIn({
      ...request, ...SUPPORTED_PAIRS[0], ...invalid,
    } as QuoteExactInRequest)).rejects.toMatchObject({ name: "RouterSdkError" });
    expect(reader.getAccounts).not.toHaveBeenCalled();
  });

  it.each([
    ...Object.values(TESTNET_MINTS).map((mint) => ({ inputMint: mint, outputMint: mint })),
    { inputMint: TESTNET.routerProgramId, outputMint: TESTNET_MINTS.aUSD },
    { inputMint: TESTNET_MINTS.aUSD, outputMint: TESTNET.routerProgramId },
  ])("rejects unsupported pair $inputMint → $outputMint before reads", async (pair) => {
    const reader = source();
    await expect(createRouterClient({ source: reader }).quoteExactIn({ ...request, ...pair }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    await expect(createRouterClient({ source: reader }).quoteForOutput({ ...request, ...pair, amountOut: 1000n }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    expect(reader.getAccounts).not.toHaveBeenCalled();
  });
});
