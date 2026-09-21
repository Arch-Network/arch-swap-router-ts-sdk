import { base58 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient, RouterSdkError, type PropAmmQuote, type PropAmmQuoteProvider } from "../src/index.js";
import { MAINNET_MINTS, NETWORKS, TESTNET_MINTS as mints, TESTNET_VENUES } from "../src/config/networks.js";
import { FIXED_ROUTES } from "../src/config/routes.js";
import { loadClamm } from "../src/clamm.js";
import { quotePropAmm } from "../src/propamm.js";
import { decodeAddress, deriveAddress, U64_MAX } from "../src/utils.js";
import { now, setup } from "./fixtures/quotes.js";

type RfqRequest = Parameters<PropAmmQuoteProvider["quoteExactIn"]>[0];
const nowMs = Number(now) * 1000;
const quoteSigner = base58.encode(new Uint8Array(32).fill(0x22));
const setU64 = (data: Uint8Array, offset: number, value: bigint) => new DataView(data.buffer).setBigUint64(offset, value, true);

function response(request: RfqRequest, estimatedAmountOut = request.inputMint === mints.aBTC ? 1_000_000_000_000n : 5_000_000n): PropAmmQuote {
  const sell = request.inputMint === mints.aBTC;
  return {
    quoteId: "rfq-1", quoteSigner, estimatedAmountOut,
    terms: {
      side: sell ? "sell" : "buy",
      baseAmount: sell ? request.amountIn : estimatedAmountOut + 17n,
      quoteAmount: sell ? estimatedAmountOut + 17n : request.amountIn,
      expiryMs: BigInt(nowMs + 20_000), nonce: 0n,
    },
  };
}

function setupRfq() {
  const state = setup();
  const request = { ...state.request, deadlineMs: nowMs + 30_000 };
  const provider = { quoteExactIn: vi.fn(async (request: RfqRequest) => response(request)) };
  return { ...state, request, provider, client: createRouterClient({ source: state.source, propAmmQuoteProvider: provider }) };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(nowMs); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("PropAMM route selection", () => {
  const routes = FIXED_ROUTES.filter((r) => r.steps.some((s) => s.venue === "clamm"));
  it("uses each quote's signer without changing custody addresses or cached quotes", async () => {
    const { client, provider, request } = setupRfq();
    const before = await client.quoteExactIn(request);
    const newSigner = base58.encode(new Uint8Array(32).fill(0x23));
    provider.quoteExactIn.mockResolvedValue({ ...response(request), quoteId: "rotated", quoteSigner: newSigner });
    const after = await client.quoteExactIn(request);
    expect(after.rfq).toEqual({ quoteId: "rotated" });
    const oldAccounts = before.instructions[1]!.accounts;
    const newAccounts = after.instructions[1]!.accounts;
    expect(base58.encode(oldAccounts[8]!.pubkey)).toBe(quoteSigner);
    expect(base58.encode(newAccounts[8]!.pubkey)).toBe(newSigner);
    expect(newAccounts[8]).toMatchObject({ is_signer: true, is_writable: false });
    expect(newAccounts.filter((_, i) => i !== 8)).toEqual(oldAccounts.filter((_, i) => i !== 8));
    expect(after.instructions[1]!.data).toEqual(before.instructions[1]!.data);
  });

  it.each(routes)("quotes $inputMint → $outputMint with shared vaults and final slippage", async (route) => {
    const { client, provider, source, request } = setupRfq();
    const quote = await client.quoteExactIn({ ...request, inputMint: route.inputMint, outputMint: route.outputMint });
    const swapIndex = route.steps.findIndex((s) => s.venue === "clamm"), swap = route.steps[swapIndex]!;
    expect(provider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({
      inputMint: swap.inputMint, outputMint: swap.outputMint,
      amountIn: swapIndex === 0 ? request.amountIn : 997_000n, user: request.user,
    });
    const rfq = response(provider.quoteExactIn.mock.calls[0]![0]);
    const expectedOut = rfq.estimatedAmountOut * (route.steps.at(-1)!.operation === "vaultMint" ? 990n : 1n);
    expect(quote.hops).toEqual(route.steps.map((step, i) => ({
      kind: step.venue === "clamm" ? "propamm" : step.operation,
      inputMint: step.inputMint, outputMint: step.outputMint,
      amountIn: i === 0 ? request.amountIn : i === swapIndex ? 997_000n : rfq.estimatedAmountOut,
      estimatedAmountOut: i < swapIndex ? 997_000n : i === swapIndex ? rfq.estimatedAmountOut : expectedOut,
    })));
    expect(quote).toMatchObject({
      amountIn: request.amountIn, estimatedAmountOut: expectedOut,
      minAmountOut: expectedOut * 9950n / 10_000n, deadlineMs: nowMs + 20_000, rfq: { quoteId: "rfq-1" },
    });
    expect(quote.instructions).toHaveLength(2);
    const data = quote.instructions[1]!.data, view = new DataView(data.buffer), offset = 26 + swapIndex;
    expect(data[offset]).toBe(3);
    expect(view.getBigUint64(offset + 2, true)).toBe(rfq.terms.baseAmount);
    expect(view.getBigUint64(offset + 10, true)).toBe(rfq.terms.quoteAmount);
    expect(view.getBigUint64(9, true)).toBe(quote.minAmountOut);
    expect(view.getBigUint64(17, true)).toBe(BigInt(quote.deadlineMs));
    expect(source.getAccounts).toHaveBeenCalledTimes(route.steps.length === 1 ? 2 : 3);
    const keys = source.getAccounts.mock.calls.flatMap(([keys]) => keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(NETWORKS.testnet.propamm.config);
    expect(client.supportedPairs).toHaveLength(12);
  });

  it.each([-1n, 0n, 1n])("selects by final output (CLAMM wins equality), difference %s", async (delta) => {
    const { client, provider, source, request } = setupRfq();
    const expected = await createRouterClient({ source }).quoteExactIn(request);
    provider.quoteExactIn.mockImplementation(async (r) => response(r, expected.estimatedAmountOut + delta));
    const quote = await client.quoteExactIn(request);
    expect(quote.rfq).toEqual(delta > 0 ? { quoteId: "rfq-1" } : undefined);
    expect(quote.hops[0]!.kind).toBe(delta > 0 ? "propamm" : "clamm");
    if (delta <= 0) expect(quote).toEqual(expected);
  });

  it("compares after suffix rounding, even when PropAMM has a higher swap output", async () => {
    const { client, provider, source, request, accounts } = setupRfq();
    setU64(accounts.get(mints.primeUSD)!.data, 36, 0n);
    const clamm = createRouterClient({ source });
    const swap = await clamm.quoteExactIn(request);
    const withSuffix = { ...request, outputMint: mints.primeUSD };
    const expected = await clamm.quoteExactIn(withSuffix);
    provider.quoteExactIn.mockImplementation(async (r) => response(r, swap.estimatedAmountOut + 1n));
    expect(await client.quoteExactIn(withSuffix)).toEqual(expected);
  });

  it("rejects an oversized PropAMM candidate and retains CLAMM", async () => {
    const { client, provider, source, request, accounts } = setupRfq();
    accounts.get(TESTNET_VENUES.usdVault.address)!.data.set(new Uint8Array(32).fill(99), 201);
    const route = { ...request, inputMint: mints.primeBTC, outputMint: mints.primeUSD };
    const expected = await createRouterClient({ source }).quoteExactIn(route);
    expect(await client.quoteExactIn(route)).toEqual(expected);
    expect(provider.quoteExactIn).toHaveBeenCalledOnce();
  });

  it.each(["pool missing", "pool malformed", "response malformed", "pool transport", "ticks malformed", "ticks transport"])(
    "keeps PropAMM when CLAMM fails: %s", async (failure) => {
      const { client, source, request, accounts } = setupRfq();
      const pool = TESTNET_VENUES.clamm.address;
      const clamm = loadClamm(accounts, true, NETWORKS.testnet);
      if (failure === "pool missing") accounts.delete(pool);
      if (failure === "pool malformed") accounts.get(pool)!.data = new Uint8Array();
      if (failure === "response malformed") accounts.get(pool)!.data = [] as unknown as Uint8Array;
      if (failure === "ticks malformed") accounts.set(clamm.addresses[0]!, { ...accounts.get(pool)!, data: new Uint8Array(3) });
      if (failure.endsWith("transport")) source.getAccounts.mockImplementation(async (keys) => {
        if (keys.includes(failure === "pool transport" ? pool : clamm.addresses[0]!)) throw new Error(failure);
        return keys.map((key) => accounts.get(key) ?? null);
      });
      expect((await client.quoteExactIn({ ...request, inputMint: mints.primeBTC, outputMint: mints.primeUSD })).rfq)
        .toEqual({ quoteId: "rfq-1" });
    },
  );

  it.each(["missing", "malformed", "paused", "transport"])("rejects required shared vault failure: %s", async (failure) => {
    const { client, source, request, accounts } = setupRfq();
    const vault = TESTNET_VENUES.btcVault.address;
    if (failure === "missing") accounts.delete(vault);
    if (failure === "malformed") accounts.get(vault)!.data = new Uint8Array();
    if (failure === "paused") accounts.get(vault)!.data[393] = 1;
    if (failure === "transport") source.getAccounts.mockRejectedValue(new RouterSdkError("RPC", "unavailable"));
    await expect(client.quoteExactIn({ ...request, inputMint: mints.primeBTC })).rejects.toBeInstanceOf(RouterSdkError);
  });

  it("settles a provider timeout after two seconds and clears its timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, provider, request } = setupRfq();
    provider.quoteExactIn.mockImplementation(() => new Promise(() => {}));
    const pending = client.quoteExactIn(request);
    await vi.advanceTimersByTimeAsync(2000);
    const quote = await pending;
    expect(quote.rfq).toBeUndefined();
    expect(quote.estimatedAmountOut).toBe(685687466535n);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("rechecks expiry after slower CLAMM reads, CLAMM fails=%s", async (failClamm) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, source, request, accounts } = setupRfq();
    source.getAccounts.mockImplementation(async (keys) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      vi.mocked(Date.now).mockReturnValue(nowMs + 25_000);
      if (failClamm) throw new Error("RPC unavailable");
      return keys.map((key) => accounts.get(key) ?? null);
    });
    const result = client.quoteExactIn(request).then((quote) => quote, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    const quote = await result;
    if (failClamm) expect(quote).toMatchObject({ code: "NO_ROUTE", cause: expect.any(AggregateError) });
    else expect(quote).toMatchObject({ instructions: expect.any(Array), deadlineMs: request.deadlineMs });
    expect(quote).not.toHaveProperty("rfq");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after success and provider rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, provider, request } = setupRfq();
    await client.quoteExactIn(request);
    expect(vi.getTimerCount()).toBe(0);
    provider.quoteExactIn.mockRejectedValue(new Error("declined"));
    expect((await client.quoteExactIn(request)).rfq).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("RFQ validation and excluded paths", () => {
  const invalidQuotes: [string, (q: PropAmmQuote) => unknown][] = [
    ["empty ID", (q) => ({ ...q, quoteId: " " })],
    ["missing signer", (q) => ({ ...q, quoteSigner: undefined })],
    ["malformed signer", (q) => ({ ...q, quoteSigner: "invalid" })],
    ["short signer", (q) => ({ ...q, quoteSigner: base58.encode(new Uint8Array(31)) })],
    ["missing terms", (q) => ({ ...q, terms: undefined })],
    ["null", () => null],
    ["side", (q) => ({ ...q, terms: { ...q.terms, side: "other" } })],
    ["opposite direction", (q) => ({ ...q, terms: { ...q.terms, side: "buy" } })],
    ["input binding", (q) => ({ ...q, terms: { ...q.terms, baseAmount: q.terms.baseAmount - 1n } })],
    ["expired", (q) => ({ ...q, terms: { ...q.terms, expiryMs: BigInt(nowMs) } })],
    ...(["baseAmount", "quoteAmount", "expiryMs", "nonce"] as const).flatMap((field) =>
      [-1n, U64_MAX + 1n, 1, undefined, ...(field === "nonce" ? [] : [0n])].map((value): [string, (q: PropAmmQuote) => unknown] =>
        [`${field}=${value}`, (q) => ({ ...q, terms: { ...q.terms, [field]: value } })])),
    ...[0n, -1n, U64_MAX + 1n, 1, undefined].map((value): [string, (q: PropAmmQuote) => unknown] =>
      [`estimate=${value}`, (q) => ({ ...q, estimatedAmountOut: value })]),
  ];
  it.each(invalidQuotes)("rejects %s but retains CLAMM", async (_, mutate) => {
    const { client, provider, request } = setupRfq();
    const invalid = mutate(response(request)) as PropAmmQuote;
    provider.quoteExactIn.mockResolvedValue(invalid);
    await expect(quotePropAmm(provider, request, NETWORKS.testnet.propamm)).rejects.toBeInstanceOf(RouterSdkError);
    expect((await client.quoteExactIn(request)).rfq).toBeUndefined();
  });

  it("retains original large terms, caps the deadline safely, and uses the skewed estimate", async () => {
    const { client, provider, request } = setupRfq();
    const input = { ...request, amountIn: 9007199254740993n };
    const terms = { side: "sell" as const, baseAmount: input.amountIn, quoteAmount: U64_MAX, expiryMs: U64_MAX, nonce: U64_MAX };
    provider.quoteExactIn.mockResolvedValue({ quoteId: "large", quoteSigner, terms, estimatedAmountOut: 1000n });
    const quote = await client.quoteExactIn(input);
    expect(quote).toMatchObject({ deadlineMs: request.deadlineMs, estimatedAmountOut: 1000n, rfq: { quoteId: "large" } });
    const data = new DataView(quote.instructions[1]!.data.buffer);
    expect(data.getBigUint64(28, true)).toBe(input.amountIn);
    for (const offset of [36, 44, 52]) expect(data.getBigUint64(offset, true)).toBe(U64_MAX);
  });

  it("rejects a Buy input mismatch and an expired requested deadline", async () => {
    const { provider, request } = setupRfq();
    const buy = { ...request, inputMint: mints.aUSD, outputMint: mints.aBTC };
    provider.quoteExactIn.mockResolvedValue({ ...response(buy), terms: { ...response(buy).terms, quoteAmount: 1n } });
    await expect(quotePropAmm(provider, buy, NETWORKS.testnet.propamm)).rejects.toMatchObject({ code: "INVALID_RFQ" });
    provider.quoteExactIn.mockClear();
    await expect(quotePropAmm(provider, { ...buy, deadlineMs: nowMs }, NETWORKS.testnet.propamm)).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(provider.quoteExactIn).not.toHaveBeenCalled();
  });

  it("applies the final positive-minimum rule to PropAMM too", async () => {
    const { client, provider, request, accounts } = setupRfq();
    accounts.delete(TESTNET_VENUES.clamm.address);
    provider.quoteExactIn.mockResolvedValue(response(request, 1n));
    await expect(client.quoteExactIn(request)).rejects.toMatchObject({ code: "NO_ROUTE" });
  });

  it.each(["buy", "sell"] as const)("uses mainnet RFQ identities for %s without testnet fallback", async (side) => {
    const { provider, source, request } = setupRfq();
    const deployment = NETWORKS.mainnet.propamm;
    const buy = side === "buy";
    const input = {
      ...request, inputMint: buy ? MAINNET_MINTS.aUSD : MAINNET_MINTS.aBTC,
      outputMint: buy ? MAINNET_MINTS.aBTC : MAINNET_MINTS.aUSD,
    };
    provider.quoteExactIn.mockResolvedValue({
      ...response(input), estimatedAmountOut: 1000n,
      terms: { side, baseAmount: buy ? 1000n : input.amountIn, quoteAmount: buy ? input.amountIn : 1000n, expiryMs: BigInt(nowMs + 20_000), nonce: 0n },
    });
    const mainnet = createRouterClient({ source, network: "mainnet", propAmmQuoteProvider: provider });
    const quote = await mainnet.quoteExactIn(input);
    expect(quote.rfq).toEqual({ quoteId: "rfq-1" });
    expect(provider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({
      inputMint: input.inputMint, outputMint: input.outputMint, amountIn: input.amountIn, user: input.user,
    });
    const instruction = quote.instructions[1]!;
    expect(base58.encode(instruction.program_id)).toBe(NETWORKS.mainnet.programs.routerProgramId);
    const config = decodeAddress(deployment.config);
    expect(instruction.accounts.slice(6, 12).map((meta) => base58.encode(meta.pubkey))).toEqual([
      deployment.programId, deployment.config, quoteSigner,
      deriveAddress(deployment.programId, "user_nonce", decodeAddress(deployment.config), decodeAddress(input.user)),
      deriveAddress(deployment.programId, "vault", config, decodeAddress(MAINNET_MINTS.aBTC)),
      deriveAddress(deployment.programId, "vault", config, decodeAddress(MAINNET_MINTS.aUSD)),
    ]);
    provider.quoteExactIn.mockClear();
    await expect(mainnet.quoteForOutput({ ...input, amountOut: 1000n })).rejects.toThrow();
    expect(provider.quoteExactIn).not.toHaveBeenCalled();
  });

  it("never calls RFQ for receive sizing, direct vaults or invalid requests", async () => {
    const { client, provider, source, request } = setupRfq();
    await client.quoteForOutput({ ...request, amountOut: 100_000n });
    for (const route of FIXED_ROUTES.filter((r) => !r.steps.some((s) => s.venue === "clamm"))) {
      await client.quoteExactIn({ ...request, inputMint: route.inputMint, outputMint: route.outputMint });
    }
    source.getAccounts.mockClear();
    for (const invalid of [
      { amountIn: 0n }, { amountIn: U64_MAX + 1n }, { slippageBps: 10000 }, { deadlineMs: -1 },
      { user: "invalid" }, { outputMint: request.inputMint }, { outputMint: base58.encode(new Uint8Array(32).fill(99)) },
    ]) await expect(client.quoteExactIn({ ...request, ...invalid })).rejects.toThrow();
    expect(source.getAccounts).not.toHaveBeenCalled();
    expect(provider.quoteExactIn).not.toHaveBeenCalled();
  });
});
