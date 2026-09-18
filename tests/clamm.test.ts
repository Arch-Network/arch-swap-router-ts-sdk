import { base58 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountInfoResult } from "@arch-network/arch-sdk";
import { createRouterClient, TESTNET_MINTS } from "../src/index.js";
import { NETWORKS, TESTNET, TESTNET_VENUES } from "../src/config/networks.js";
import { FIXED_ROUTES } from "../src/config/routes.js";
import { decodePool, decodeTickArray, loadClamm, prepareClammQuote, simulateClamm, tickSqrtPrice, tickWindow } from "../src/clamm.js";
import { decodeAddress, deriveAddress, U64_MAX } from "../src/utils.js";
import { expectedRouterInstruction, fixtures, namedFixture } from "./transactions/fixtures.js";
import native from "./fixtures/clamm/native.json" with { type: "json" };
import { setup, now } from "./fixtures/quotes.js";

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
const info = (data: Uint8Array, owner: string = TESTNET.clammProgramId): AccountInfoResult => ({
  data, owner: decodeAddress(owner), lamports: 1, utxo: "fixture:0", is_executable: false,
});
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const setU64 = (data: Uint8Array, offset: number, value: bigint) => view(data).setBigUint64(offset, value, true);
const setU128 = (data: Uint8Array, offset: number, value: bigint) => {
  setU64(data, offset, value & U64_MAX); setU64(data, offset + 8, value >> 64n);
};
const poolAddress = TESTNET_VENUES.clamm.address;


function emptyTickArray(start: number): Uint8Array {
  const data = new Uint8Array(9988);
  data.set(bytes(native.tickArray).subarray(0, 8));
  view(data).setInt32(8, start, true);
  data.set(decodeAddress(poolAddress), 9956);
  return data;
}

describe("native CLAMM contract", () => {
  it("uses selected pool, mints and programs through both account stages", () => {
    const key = (byte: number) => base58.encode(new Uint8Array(32).fill(byte));
    const programs = { ...TESTNET, clammProgramId: key(61), tokenProgramId: key(62), systemProgramId: key(63) };
    const venue = { address: key(64), tokenMintA: key(65), tokenMintB: key(66) };
    const config = { ...NETWORKS.testnet, programs, venues: { ...TESTNET_VENUES, clamm: venue } };
    const { accounts } = setup();
    const pool = accounts.get(poolAddress)!;
    pool.owner = decodeAddress(programs.clammProgramId);
    pool.data.set(decodeAddress(venue.tokenMintA), 101); pool.data.set(decodeAddress(venue.tokenMintB), 181);
    accounts.delete(poolAddress); accounts.set(venue.address, pool);
    for (const [oldMint, mint] of [[TESTNET_MINTS.aBTC, venue.tokenMintA], [TESTNET_MINTS.aUSD, venue.tokenMintB]]) {
      const account = accounts.get(oldMint!)!;
      account.owner = decodeAddress(programs.tokenProgramId);
      accounts.delete(oldMint!); accounts.set(mint!, account);
    }
    const state = loadClamm(accounts, true, config);
    expect(state.resolved).toMatchObject({
      pool: venue.address, outputMint: venue.tokenMintB,
      oracle: deriveAddress(programs.clammProgramId, "oracle", decodeAddress(venue.address)),
    });
    state.addresses.forEach((address, i) => {
      expect(address).toBe(deriveAddress(programs.clammProgramId, "tick_array", decodeAddress(venue.address), new TextEncoder().encode(String(state.starts[i]))));
      const data = emptyTickArray(state.starts[i]!); data.set(decodeAddress(venue.address), 9956);
      accounts.set(address, info(data, programs.clammProgramId));
    });
    const estimate = prepareClammQuote(state, accounts).estimate(1_000_000_000n);
    expect(estimate).toBe(BigInt(native.cases[0]!.expected.amountOut!));
    // Empty system-owned ticks use this deployment's system program too.
    const first = state.addresses[0]!;
    accounts.set(first, info(new Uint8Array(), programs.systemProgramId));
    expect(prepareClammQuote(state, accounts).estimate(1_000_000_000n)).toBe(estimate);
    // An array for the old testnet pool must be rejected even under the right owner.
    accounts.set(first, info(emptyTickArray(state.starts[0]!), programs.clammProgramId));
    expect(() => prepareClammQuote(state, accounts)).toThrow(expect.objectContaining({ code: "INVALID_ACCOUNT" }));
    pool.owner = decodeAddress(TESTNET.clammProgramId);
    expect(() => loadClamm(accounts, true, config)).toThrow(expect.objectContaining({ code: "INVALID_ACCOUNT" }));
  });

  it.each(native.ticks)("matches native tick $tick", ({ tick, sqrtPrice }) => {
    expect(tickSqrtPrice(tick)).toBe(BigInt(sqrtPrice));
  });

  it("decodes the native Borsh pool including a byte view", () => {
    const raw = bytes(native.cases[0]!.pool), padded = new Uint8Array(raw.length + 5);
    padded.set(raw, 3);
    expect(decodePool(padded.subarray(3, -2))).toEqual({
      tickSpacing: 128, tickCurrentIndex: 65599, sqrtPrice: 490131584757706650314n,
      liquidity: 1_000_000_000_000n, feeRate: 3000,
      tokenMintA: TESTNET_MINTS.aBTC, tokenMintB: TESTNET_MINTS.aUSD,
      tokenVaultA: base58.encode(new Uint8Array(32).fill(31)),
      tokenVaultB: base58.encode(new Uint8Array(32).fill(32)),
    });
  });

  it("decodes native packed tick bytes with signed i128 liquidity", () => {
    const raw = bytes(native.tickArray), padded = new Uint8Array(raw.length + 5);
    padded.set(raw, 3);
    expect(decodeTickArray(padded.subarray(3, -2), -11264, 128, TESTNET_VENUES.clamm.address)).toEqual([
      { index: -11264, liquidityNet: -123456789012345678901n },
      { index: -128, liquidityNet: 987654321n },
    ]);
  });

  it.each(native.cases)("matches native swap $name", (fixture) => {
    const pool = decodePool(bytes(fixture.pool));
    expect(tickWindow(pool.tickCurrentIndex, pool.tickSpacing, fixture.aToB)).toEqual(fixture.starts);
    const state = loadClamm(setup(bytes(fixture.pool)).accounts, fixture.aToB, NETWORKS.testnet);
    expect(state.resolved.sqrtPriceLimit).toBe(BigInt(fixture.limit));
    const ticks = fixture.ticks.map((tick) => ({ index: tick.index, liquidityNet: BigInt(tick.liquidityNet) }))
      .sort((a, b) => fixture.aToB ? b.index - a.index : a.index - b.index);
    const run = () => simulateClamm(pool, ticks, BigInt(fixture.amount), fixture.aToB, BigInt(fixture.limit));
    if (fixture.expected.error) {
      expect(run).toThrow(expect.objectContaining({ code: fixture.name === "limit-equals-price" ? "INSUFFICIENT_LIQUIDITY" : "MATH_OVERFLOW" }));
    } else {
      expect(run()).toMatchObject({
        amountIn: BigInt(fixture.expected.amountIn!), amountOut: BigInt(fixture.expected.amountOut!),
        sqrtPrice: BigInt(fixture.expected.sqrtPrice!), liquidity: BigInt(fixture.expected.liquidity!),
      });
    }
  });

  it.each([
    [0, 128, true, [0, -11264, -22528]], [0, 128, false, [0, 11264, 22528]],
    [-129, 128, false, [-11264, 0, 11264]], [-128, 128, false, [0, 11264, 22528]],
    [-1, 128, true, [-11264, -22528, -33792]], [-11264, 128, true, [-11264, -22528, -33792]],
    [-11265, 128, true, [-22528, -33792, -45056]], [11135, 128, false, [0, 11264, 22528]],
    [11136, 128, false, [11264, 22528, 33792]], [11264, 128, false, [11264, 22528, 33792]],
    [-443636, 128, true, [-450560]], [443636, 128, false, [439296]],
    [0, 1, true, [0, -88, -176]], [-1, 1, false, [0, 88, 176]],
  ] as const)("matches router e2e tick window %s/%s/%s", (tick, spacing, direction, expected) => {
    expect(tickWindow(tick, spacing, direction)).toEqual(expected);
  });

  it.each([
    (data: Uint8Array) => data.subarray(0, 652),
    (data: Uint8Array) => new Uint8Array([...data, 0]),
    (data: Uint8Array) => { data[0] = 0; return data; },
    (data: Uint8Array) => { view(data).setUint16(41, 0, true); return data; },
    (data: Uint8Array) => { view(data).setUint16(43, 1, true); return data; },
    (data: Uint8Array) => { view(data).setInt32(81, -443638, true); return data; },
    (data: Uint8Array) => { setU128(data, 65, 1n); return data; },
  ])("rejects malformed pool %#", (mutate) => {
    expect(() => decodePool(mutate(bytes(native.cases[0]!.pool))))
      .toThrow(expect.objectContaining({ code: "INVALID_ACCOUNT" }));
  });

  it.each([
    (data: Uint8Array) => data.subarray(0, 9987),
    (data: Uint8Array) => { data[0] = 0; return data; },
    (data: Uint8Array) => { view(data).setInt32(8, 0, true); return data; },
    (data: Uint8Array) => { data[9956] = 0; return data; },
    (data: Uint8Array) => { data[12] = 2; return data; },
  ])("rejects malformed ticks %#", (mutate) => {
    expect(() => decodeTickArray(mutate(bytes(native.tickArray)), -11264, 128, TESTNET_VENUES.clamm.address))
      .toThrow(expect.objectContaining({ code: "INVALID_ACCOUNT" }));
  });
});

describe("fixed route quotes", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Number(now) * 1000); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["quoteExactIn", "quoteForOutput"] as const)("keeps explicit testnet %s identical while a mainnet client coexists", async (method) => {
    const { source, request, client } = setup();
    const mainnetSource = { getAccounts: vi.fn(async () => { throw new Error("Unexpected mainnet read"); }) };
    const mainnet = createRouterClient({ source: mainnetSource, network: "mainnet" });
    const testnet = createRouterClient({ source, network: "testnet" });
    const input = { ...request, inputMint: TESTNET_MINTS.primeBTC, outputMint: TESTNET_MINTS.primeUSD, amountOut: 1_000_000n };
    const expected = await client[method](input);
    const [actual, unavailable] = await Promise.allSettled([testnet[method](input), mainnet[method](input)]);
    expect(actual).toEqual({ status: "fulfilled", value: expected });
    expect(unavailable).toMatchObject({ status: "rejected", reason: { code: "UNSUPPORTED_PAIR" } });
    expect(source.getAccounts).toHaveBeenCalledTimes(4);
    expect(mainnetSource.getAccounts).not.toHaveBeenCalled();
  });

  it.each(native.routes)("quotes $input → $output against native composition", async (expected) => {
    const { accounts, source, request, client } = setup();
    const inputMint = TESTNET_MINTS[expected.input as keyof typeof TESTNET_MINTS];
    const outputMint = TESTNET_MINTS[expected.output as keyof typeof TESTNET_MINTS];
    const route = FIXED_ROUTES.find((r) => r.inputMint === inputMint && r.outputMint === outputMint)!;
    const containsClamm = route.steps.some((s) => s.venue === "clamm");
    const quote = await client.quoteExactIn({ ...request, inputMint, outputMint });
    expect(quote.estimatedAmountOut).toBe(BigInt(expected.amountOut));
    expect(quote.minAmountOut).toBe(BigInt(expected.minAmountOut));
    expect(quote.amountIn).toBe(BigInt(expected.amountIn));
    expect(quote.instructions).toHaveLength(1);
    expect(source.getAccounts).toHaveBeenCalledTimes(containsClamm ? 2 : 1);
    const allKeys = source.getAccounts.mock.calls.flatMap(([keys]) => keys);
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(source.getAccounts.mock.calls[0]![0]).toHaveLength(containsClamm ? 3 + 3 * (route.steps.length - 1) : 4);
    expect(allKeys).not.toContain(request.user);
    expect(allKeys).not.toContain(TESTNET.routerProgramId);
    expect(Date.now).toHaveBeenCalledTimes(1);
    const fixture = fixtures.find((f) => f.mints[0] === inputMint && f.mints[f.mints.length - 1] === outputMint)!;
    const nativeInstruction = expectedRouterInstruction(fixture);
    const data = new Uint8Array(nativeInstruction.data);
    setU64(data, 1, quote.amountIn); setU64(data, 9, BigInt(expected.minAmountOut));
    let offset = 26;
    for (const step of route.steps) {
      if (step.venue === "clamm") {
        const clamm = loadClamm(accounts, step.inputMint === TESTNET_MINTS.aBTC, NETWORKS.testnet);
        setU128(data, offset + 2, clamm.resolved.sqrtPriceLimit);
        expect(source.getAccounts.mock.calls[1]![0]).toEqual(clamm.addresses);
        offset += 19;
      } else offset++;
    }
    expect(quote.instructions[0]).toEqual({ ...nativeInstruction, data });
  });

  it.each(native.routes)("sizes input for native $input → $output output with the same read budget", async (expected) => {
    const { source, request, client } = setup();
    const pair = {
      inputMint: TESTNET_MINTS[expected.input as keyof typeof TESTNET_MINTS],
      outputMint: TESTNET_MINTS[expected.output as keyof typeof TESTNET_MINTS],
    };
    const route = FIXED_ROUTES.find((r) => r.inputMint === pair.inputMint && r.outputMint === pair.outputMint)!;
    const quote = await client.quoteForOutput({ ...request, ...pair, amountOut: BigInt(expected.amountOut) });
    expect(quote.estimatedAmountOut).toBe(BigInt(expected.amountOut));
    expect(quote.minAmountOut).toBe(BigInt(expected.minAmountOut));
    expect(quote.amountIn).toBeLessThanOrEqual(BigInt(expected.amountIn));
    expect(source.getAccounts).toHaveBeenCalledTimes(route.steps.some((s) => s.venue === "clamm") ? 2 : 1);
    const allKeys = source.getAccounts.mock.calls.flatMap(([keys]) => keys);
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(Date.now).toHaveBeenCalledTimes(1);
    // The selected input and instruction must agree with the existing forward quote.
    expect(await client.quoteExactIn({ ...request, ...pair, amountIn: quote.amountIn })).toEqual(quote);
    const previous = await client.quoteExactIn({ ...request, ...pair, amountIn: quote.amountIn - 1n, slippageBps: 0 });
    expect(previous.estimatedAmountOut).toBeLessThan(BigInt(expected.amountOut));
  });

  it("keeps granularity overshoot visible and applies slippage to the actual estimate", async () => {
    const { client, source, request } = setup();
    const quote = await client.quoteForOutput({ ...request, outputMint: TESTNET_MINTS.primeBTC, amountOut: 1001n });
    expect(quote).toMatchObject({ amountIn: 3n, estimatedAmountOut: 2000n, minAmountOut: 1990n });
    expect(source.getAccounts).toHaveBeenCalledTimes(1);
  });

  it("refreshes receive estimates on each call without adding reads during the search", async () => {
    const { accounts, source, request, client } = setup();
    const first = await client.quoteForOutput({ ...request, amountOut: 1_000_000n });
    const pool = accounts.get(poolAddress)!.data;
    view(pool).setInt32(81, -129, true); setU128(pool, 65, tickSqrtPrice(-129));
    const second = await client.quoteForOutput({ ...request, amountOut: 1_000_000n });
    expect(second.amountIn).not.toBe(first.amountIn);
    expect(source.getAccounts).toHaveBeenCalledTimes(4);
  });

  it("sizes u64-scale inputs without converting amounts to numbers", async () => {
    const fixture = native.cases.find((c) => c.name === "u64-input")!;
    const { source, request, client } = setup(bytes(fixture.pool));
    const quote = await client.quoteForOutput({ ...request, inputMint: TESTNET_MINTS.aUSD,
      outputMint: TESTNET_MINTS.aBTC, amountOut: BigInt(fixture.expected.amountOut!),
    });
    expect(quote.estimatedAmountOut).toBe(BigInt(fixture.expected.amountOut!));
    expect(quote.amountIn).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
  });

  it.each(["window-exhausted", "zero-liquidity", "limit-equals-price", "u256-overflow"])(
    "rejects an unreachable receive target: %s", async (name) => {
      const fixture = native.cases.find((c) => c.name === name)!;
      const { source, client, request } = setup(bytes(fixture.pool));
      await expect(client.quoteForOutput({ ...request, amountOut: BigInt(fixture.expected.amountOut ?? "0") + 1n,
        ...(fixture.aToB ? {} : { inputMint: TESTNET_MINTS.aUSD, outputMint: TESTNET_MINTS.aBTC }),
      })).rejects.toMatchObject({ code: name === "u256-overflow" ? "MATH_OVERFLOW" : "INSUFFICIENT_LIQUIDITY" });
      expect(source.getAccounts).toHaveBeenCalledTimes(2);
    },
  );

  it("refreshes both batches and changes the tick window on subsequent calls", async () => {
    const { accounts, source, request, client } = setup();
    const first = await client.quoteExactIn(request);
    const pool = accounts.get(poolAddress)!.data;
    view(pool).setInt32(81, -129, true); setU128(pool, 65, tickSqrtPrice(-129));
    const second = await client.quoteExactIn(request);
    expect(second.estimatedAmountOut).not.toBe(first.estimatedAmountOut);
    expect(source.getAccounts).toHaveBeenCalledTimes(4);
    expect(source.getAccounts.mock.calls[3]).not.toEqual(source.getAccounts.mock.calls[1]);
  });

  it.each([null, "empty", "initialized"])("handles native empty ticks represented as %s", async (kind) => {
    const { accounts, client, request } = setup();
    const state = loadClamm(accounts, true, NETWORKS.testnet);
    for (const [i, address] of state.addresses.entries()) {
      accounts.set(address, kind === null ? null : kind === "empty"
        ? info(new Uint8Array(), TESTNET.systemProgramId) : info(emptyTickArray(state.starts[i]!)));
    }
    expect((await client.quoteExactIn(request)).estimatedAmountOut).toBe(685687466535n);
  });

  it.each(["cross-gap-right", "cross-gap-left", "zero-start-cross", "inclusive-left", "exclusive-right", "recover-from-minimum"])(
    "quotes initialized tick crossings through the public API: %s", async (name) => {
      const fixture = native.cases.find((c) => c.name === name)!;
      const { accounts, source, client, request } = setup(bytes(fixture.pool));
      const state = loadClamm(accounts, fixture.aToB, NETWORKS.testnet);
      for (const [i, address] of state.addresses.entries()) {
        const start = state.starts[i]!, data = emptyTickArray(start);
        for (const tick of fixture.ticks) {
          const index = (tick.index - start) / state.pool.tickSpacing;
          if (index < 0 || index >= 88) continue;
          const offset = 12 + index * 113;
          const net = BigInt(tick.liquidityNet);
          data[offset] = 1;
          setU128(data, offset + 1, BigInt.asUintN(128, net));
          setU128(data, offset + 17, net < 0n ? -net : net);
        }
        accounts.set(address, info(data));
      }
      const quote = await client.quoteExactIn({ ...request, amountIn: BigInt(fixture.amount),
        ...(fixture.aToB ? {} : { inputMint: TESTNET_MINTS.aUSD, outputMint: TESTNET_MINTS.aBTC }),
      });
      expect(quote.estimatedAmountOut).toBe(BigInt(fixture.expected.amountOut!));
      expect(source.getAccounts).toHaveBeenCalledTimes(2);
      const receive = await client.quoteForOutput({ ...request, amountOut: quote.estimatedAmountOut,
        ...(fixture.aToB ? {} : { inputMint: TESTNET_MINTS.aUSD, outputMint: TESTNET_MINTS.aBTC }),
      });
      expect(receive.estimatedAmountOut).toBe(quote.estimatedAmountOut);
      expect(receive.amountIn).toBeLessThanOrEqual(quote.amountIn);
      expect(source.getAccounts).toHaveBeenCalledTimes(4);
    },
  );

  it("repeats boundary instruction slots while fetching their address only once", async () => {
    const fixture = native.cases.find((c) => c.name === "lower-bound")!;
    const { accounts, client, source, request } = setup(bytes(fixture.pool));
    const state = loadClamm(accounts, true, NETWORKS.testnet);
    expect(state.addresses).toHaveLength(1);
    expect(state.resolved.tickArrays).toEqual(Array(3).fill(state.addresses[0]));
    expect(state.resolved.supplementalTickArrays).toEqual([]);
    await expect(client.quoteExactIn({ ...request, amountIn: BigInt(fixture.amount) }))
      .rejects.toMatchObject({ code: "ZERO_OUTPUT" });
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
    expect(source.getAccounts.mock.calls[1]![0]).toEqual(state.addresses);
  });

  it.each(["window-exhausted", "zero-liquidity", "fee-dust", "limit-equals-price"])("rejects an unavailable quote: %s", async (name) => {
    const fixture = native.cases.find((c) => c.name === name)!;
    const { client, request } = setup(bytes(fixture.pool));
    await expect(client.quoteExactIn({ ...request, amountIn: BigInt(fixture.amount),
      ...(fixture.aToB ? {} : { inputMint: TESTNET_MINTS.aUSD, outputMint: TESTNET_MINTS.aBTC }),
    })).rejects.toMatchObject({ code: name === "fee-dust" ? "ZERO_OUTPUT" : "INSUFFICIENT_LIQUIDITY" });
  });

  it.each(["missing", "owner", "pair"])("rejects invalid pool before tick reads: %s", async (failure) => {
    const { accounts, source, client, request } = setup();
    if (failure === "missing") accounts.set(poolAddress, null);
    else if (failure === "owner") accounts.get(poolAddress)!.owner = decodeAddress(TESTNET.tokenProgramId);
    else accounts.get(poolAddress)!.data.set(decodeAddress(TESTNET_MINTS.primeBTC), 101);
    await expect(client.quoteExactIn(request)).rejects.toMatchObject({ code: failure === "missing" ? "MISSING_ACCOUNT" : "INVALID_ACCOUNT" });
    expect(source.getAccounts).toHaveBeenCalledTimes(1);
  });

  it("rejects tick transport failures, malformed batches and invalid ownership", async () => {
    const { accounts, source, client, request } = setup();
    const state = loadClamm(accounts, true, NETWORKS.testnet);
    const error = new Error("Tick batch unavailable");
    source.getAccounts.mockImplementationOnce(async (keys) => keys.map((key) => accounts.get(key) ?? null))
      .mockRejectedValueOnce(error);
    await expect(client.quoteExactIn(request)).rejects.toBe(error);
    source.getAccounts.mockImplementationOnce(async (keys) => keys.map((key) => accounts.get(key) ?? null))
      .mockResolvedValueOnce([]);
    await expect(client.quoteExactIn(request)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    accounts.set(state.addresses[0]!, info(new Uint8Array(), TESTNET.tokenProgramId));
    await expect(client.quoteExactIn(request)).rejects.toMatchObject({ code: "INVALID_ACCOUNT" });
    accounts.delete(state.addresses[0]!);
    expect((await client.quoteExactIn(request)).estimatedAmountOut).toBe(685687466535n);
  });

  it("propagates each hop's eligibility failure without a route fallback", async () => {
    const { accounts, client, request } = setup();
    const vault = accounts.get(TESTNET_VENUES.btcVault.address)!.data;
    setU64(vault, 48, 43n);
    await expect(client.quoteExactIn({ ...request, inputMint: TESTNET_MINTS.primeBTC, outputMint: TESTNET_MINTS.primeUSD }))
      .rejects.toMatchObject({ code: "REDEEM_UNAVAILABLE" });
    setU64(vault, 48, 42n);
    const outputVault = accounts.get(TESTNET_VENUES.usdVault.address)!.data;
    setU64(outputVault, 24, 0n);
    await expect(client.quoteExactIn({ ...request, inputMint: TESTNET_MINTS.primeBTC, outputMint: TESTNET_MINTS.primeUSD }))
      .rejects.toMatchObject({ code: "DEPOSIT_CAP" });
  });

  it("validates tick ownership/pool identity even if the swap would not reach that array", () => {
    const { accounts } = setup();
    const state = loadClamm(accounts, true, NETWORKS.testnet);
    const ticks = new Map(state.addresses.map((address) => [address, null as AccountInfoResult | null]));
    const data = emptyTickArray(state.starts[2]!); data[9956] = 0;
    ticks.set(state.addresses[2]!, info(data));
    expect(() => prepareClammQuote(state, ticks)).toThrow(expect.objectContaining({ code: "INVALID_ACCOUNT" }));
  });

  it("uses the decimal PDA seed pinned by the Rust instruction fixture", () => {
    const address = deriveAddress(TESTNET.clammProgramId, "tick_array", decodeAddress(poolAddress), new TextEncoder().encode("56320"));
    expect(address).toBe(namedFixture("direct-clamm-btc").hops[0]!.accounts[4]!.pubkey);
  });
});
