import { TransactionUtil } from "@arch-network/arch-sdk";
import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET_AETH_USD as market, type DirectRfqQuote, type QuoteExactInRequest } from "../src/index.js";
import { MAINNET_MINTS } from "../src/config/networks.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };
import { nativeTransaction } from "./fixtures/aeth-usd/transactions.js";

function setup(side = "buy") {
  const fixture = fixtures.cases.find(value => value.side === side)!;
  const request = {
    inputMint: fixture.input_mint, outputMint: fixture.output_mint,
    amountIn: BigInt(fixture.amount_in), slippageBps: 100,
    user: fixtures.user, deadlineMs: fixtures.now_ms + 60_000,
  };
  const rfq: DirectRfqQuote = {
    transaction: nativeTransaction(fixture.transaction_hex), quoteId: `${side}-quote`,
    expiresAtMs: BigInt(fixture.expires_at_ms), estimatedAmountOut: BigInt(fixture.estimated_amount_out),
  };
  const source = { getAccounts: vi.fn(async () => { throw new Error("Unexpected read"); }) };
  const directRfqQuoteProvider = { quoteExactIn: vi.fn(async (_request: QuoteExactInRequest) => rfq) };
  const propAmmQuoteProvider = { quoteExactIn: vi.fn(async () => { throw new Error("Unexpected legacy RFQ"); }) };
  const options = { source, network: "mainnet" as const, directRfqQuoteProvider, propAmmQuoteProvider };
  return { fixture, request, rfq, ...options, options, router: createRouterClient(options) };
}

function expectNoFallback({ source, propAmmQuoteProvider }: ReturnType<typeof setup>) {
  expect(source.getAccounts).not.toHaveBeenCalled();
  expect(propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("direct ETH/USD client dispatch", () => {
  it.each(["buy", "sell"])("returns the validated original %s transaction through the public API", async side => {
    const state = setup(side);
    const result = await state.router.quoteExactIn(state.request);
    expect(result).toMatchObject({
      execution: "serverTransaction", inputMint: state.request.inputMint, outputMint: state.request.outputMint,
      amountIn: state.request.amountIn, estimatedAmountOut: state.rfq.estimatedAmountOut,
      minAmountOut: BigInt(state.fixture.min_amount_out), deadlineMs: state.fixture.expires_at_ms,
      rfq: { quoteId: state.rfq.quoteId },
      hops: [{ kind: side === "buy" ? "treasuryMint" : "propamm", inputMint: state.request.inputMint,
        outputMint: state.request.outputMint, amountIn: state.request.amountIn, estimatedAmountOut: state.rfq.estimatedAmountOut }],
    });
    if (result.execution !== "serverTransaction") throw new Error("Expected a server transaction");
    expect(result.transaction).toBe(state.rfq.transaction);
    expect(hex.encode(TransactionUtil.serialize(result.transaction))).toBe(state.fixture.transaction_hex);
    expect(result).not.toHaveProperty("instructions");
    expect(state.directRfqQuoteProvider.quoteExactIn.mock.calls).toEqual([[state.request]]);
    expectNoFallback(state);
  });

  it.each(["buy", "sell"])("preserves a different server blockhash and account ordering for %s", async side => {
    const state = setup(side);
    const { message } = state.rfq.transaction;
    message.recent_blockhash = new Uint8Array(32).fill(0x66);
    // Swap two writable unsigned keys and remap every compiled reference.
    // This is the same valid template with an ordering a compiler could replace.
    [message.account_keys[2], message.account_keys[3]] = [message.account_keys[3]!, message.account_keys[2]!];
    const remap = (index: number) => index === 2 ? 3 : index === 3 ? 2 : index;
    for (const instruction of message.instructions) {
      instruction.program_id_index = remap(instruction.program_id_index);
      instruction.accounts = instruction.accounts.map(remap);
    }
    const expectedBytes = hex.encode(TransactionUtil.serialize(state.rfq.transaction));
    expect(expectedBytes).not.toBe(state.fixture.transaction_hex);
    const result = await state.router.quoteExactIn(state.request);
    if (result.execution !== "serverTransaction") throw new Error("Expected a server transaction");
    expect(result.transaction).toBe(state.rfq.transaction);
    expect(hex.encode(TransactionUtil.serialize(result.transaction))).toBe(expectedBytes);
    expectNoFallback(state);
  });

  it.each(["buy", "sell"])("accepts %s one millisecond before the earlier client deadline without rewriting expiry", async side => {
    const state = setup(side);
    state.request.deadlineMs = fixtures.now_ms + 1;
    const result = await state.router.quoteExactIn(state.request);
    expect(result.deadlineMs).toBe(state.request.deadlineMs);
    if (result.execution !== "serverTransaction") throw new Error("Expected a server transaction");
    expect(hex.encode(TransactionUtil.serialize(result.transaction))).toBe(state.fixture.transaction_hex);
  });

  it.each(["buy", "sell"])("rejects %s when the client deadline elapses before the still-fresh server expiry", async side => {
    const state = setup(side);
    state.request.deadlineMs = fixtures.now_ms + 10_000;
    state.directRfqQuoteProvider.quoteExactIn.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(state.request.deadlineMs);
      return state.rfq;
    });
    await expect(state.router.quoteExactIn(state.request)).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledTimes(1);
    expectNoFallback(state);
  });

  it("adds exactly two frozen pairs to mainnet metadata without changing the legacy mints", () => {
    const { router, source } = setup();
    const legacy = createRouterClient({ network: "mainnet", source });
    expect(router.supportedPairs).toEqual([
      ...legacy.supportedPairs,
      { inputMint: market.quoteMint, outputMint: market.baseMint },
      { inputMint: market.baseMint, outputMint: market.quoteMint },
    ]);
    expect(router.supportedPairs).toHaveLength(14);
    expect(new Set(router.supportedPairs.map(pair => `${pair.inputMint}/${pair.outputMint}`)).size).toBe(14);
    expect(Object.isFrozen(router.supportedPairs)).toBe(true);
    expect(router.supportedPairs.every(Object.isFrozen)).toBe(true);
    expect(router.mints).toBe(legacy.mints);
  });

  it.each(["buy", "sell"])("requires an explicit mainnet provider for %s", async side => {
    const state = setup(side);
    const router = createRouterClient({ network: "mainnet", source: state.source });
    expect(router.supportedPairs).toHaveLength(12);
    await expect(router.quoteExactIn(state.request)).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expectNoFallback(state);
  });

  it.each([undefined, "testnet"] as const)("keeps the direct provider disabled on network %s", async network => {
    const state = setup();
    const router = createRouterClient({ source: state.source, directRfqQuoteProvider: state.directRfqQuoteProvider,
      ...(network && { network }) });
    const legacy = createRouterClient({ source: state.source });
    expect(router.supportedPairs).toEqual(legacy.supportedPairs);
    for (const side of ["buy", "sell"]) {
      await expect(router.quoteExactIn(setup(side).request)).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    }
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expectNoFallback(state);
  });

  it.each(["buy", "sell"])("rejects receive sizing for %s before any I/O", async side => {
    const state = setup(side);
    const { amountIn: _amountIn, ...request } = state.request;
    await expect(state.router.quoteForOutput({ ...request, amountOut: 1n })).rejects.toMatchObject({
      code: "UNSUPPORTED_PAIR", message: "aETH/aUSD supports exact-input quotes only.",
    });
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expectNoFallback(state);
  });

  const unsupported = [
    [market.baseMint, MAINNET_MINTS.aBTC], [MAINNET_MINTS.aBTC, market.baseMint],
    [market.baseMint, MAINNET_MINTS.primeUSD], [MAINNET_MINTS.primeUSD, market.baseMint],
    [market.baseMint, market.baseMint], [market.baseMint, "92Vu6DVnoeqgwexfVwDMseaZAe4PQzUQBBU2Rae1aDeS"],
    ["Bfbd38zzuJkKSyiSUzwsp1aJ26L9HdwVpHeAYrodXw1D", market.quoteMint],
  ];
  it.each(unsupported)("rejects unsupported combination %s → %s without routing", async (inputMint, outputMint) => {
    const state = setup();
    const request = { ...state.request, inputMint: inputMint!, outputMint: outputMint! };
    await expect(state.router.quoteExactIn(request)).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    await expect(state.router.quoteForOutput({ ...request, amountOut: 1n })).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expectNoFallback(state);
  });

  it.each([
    { amountIn: 0n }, { amountIn: -1n }, { amountIn: 1n << 64n }, { amountIn: 1000 },
    { user: "invalid" }, { inputMint: "invalid" }, { outputMint: "invalid" },
    { slippageBps: -1 }, { slippageBps: 10_000 }, { slippageBps: 0.5 },
    { deadlineMs: -1 }, { deadlineMs: 0.5 }, { deadlineMs: Number.MAX_SAFE_INTEGER + 1 },
  ])("validates requests before calling the provider (%#)", async invalid => {
    const state = setup();
    await expect(state.router.quoteExactIn({ ...state.request, ...invalid } as QuoteExactInRequest))
      .rejects.toMatchObject({ name: "RouterSdkError" });
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expectNoFallback(state);
  });

  it.each([-1, 0])("rejects an expired request at deadline offset %s before fetching", async offset => {
    const state = setup();
    await expect(state.router.quoteExactIn({ ...state.request, deadlineMs: fixtures.now_ms + offset }))
      .rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expectNoFallback(state);
  });

  it.each(["throw", "reject"])("propagates a provider %s once without fallback", async mode => {
    const state = setup();
    const error = new Error("Server rejected quote");
    state.directRfqQuoteProvider.quoteExactIn.mockImplementation(() => {
      if (mode === "throw") throw error;
      return Promise.reject(error);
    });
    await expect(state.router.quoteExactIn(state.request)).rejects.toBe(error);
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledTimes(1);
    expectNoFallback(state);
  });

  it.each(["buy", "sell"])("uses the %s validator and surfaces invalid responses without fallback", async side => {
    const state = setup(side);
    state.rfq.transaction.message.instructions[0]!.data[0] = 255;
    await expect(state.router.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledTimes(1);
    expectNoFallback(state);
  });

  it.each(["buy", "sell"])("rejects a %s that expires while the provider is running", async side => {
    const state = setup(side);
    state.directRfqQuoteProvider.quoteExactIn.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(state.fixture.expires_at_ms);
      return state.rfq;
    });
    await expect(state.router.quoteExactIn(state.request)).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledTimes(1);
    expectNoFallback(state);
  });

  it("bounds a stalled provider to two seconds without retrying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixtures.now_ms);
    const state = setup();
    state.directRfqQuoteProvider.quoteExactIn.mockImplementation(() => new Promise(() => {}));
    const settled = vi.fn();
    const pending = state.router.quoteExactIn(state.request).catch(error => { settled(); return error; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ code: "RFQ_TIMEOUT" });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expectNoFallback(state);
  });

  it.each(["success", "rejection"])("cleans up the timeout after provider %s", async outcome => {
    vi.useFakeTimers();
    vi.setSystemTime(fixtures.now_ms);
    const state = setup();
    if (outcome === "rejection") state.directRfqQuoteProvider.quoteExactIn.mockRejectedValue(new Error("Rejected"));
    const pending = state.router.quoteExactIn(state.request);
    if (outcome === "rejection") await expect(pending).rejects.toThrow("Rejected");
    else await expect(pending).resolves.toMatchObject({ execution: "serverTransaction" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("binds validation to the original request even if the caller or provider mutates its copy", async () => {
    const state = setup();
    state.directRfqQuoteProvider.quoteExactIn.mockImplementation(async request => {
      expect(request).not.toBe(state.request);
      expect(request.amountIn).toBe(BigInt(state.fixture.amount_in));
      Reflect.set(request, "amountIn", 1n);
      Reflect.set(request, "user", market.treasuryAuthority);
      return state.rfq;
    });
    const pending = state.router.quoteExactIn(state.request);
    state.request.amountIn = 2n;
    state.request.user = market.quoteSigner;
    await expect(pending).resolves.toMatchObject({ amountIn: BigInt(state.fixture.amount_in) });
  });

  it("keeps legacy exact-input and receive requests on the existing path when enabled", async () => {
    const state = setup();
    const router = createRouterClient({ source: state.source, network: "mainnet", directRfqQuoteProvider: state.directRfqQuoteProvider });
    const request = { ...state.request, inputMint: MAINNET_MINTS.aBTC, outputMint: MAINNET_MINTS.aUSD };
    await expect(router.quoteExactIn(request)).rejects.toThrow("Unexpected read");
    await expect(router.quoteForOutput({ ...request, amountOut: 1000n })).rejects.toThrow("Unexpected read");
    expect(state.source.getAccounts).toHaveBeenCalledTimes(2);
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });
});
