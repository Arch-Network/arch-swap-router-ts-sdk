import { base58 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKS, TESTNET_MINTS as mints, TESTNET_VENUES as venues } from "../src/config/networks.js";
import { buildRouteGraph, findRoutes } from "../src/config/routes.js";
import { RouterSdkError } from "../src/errors.js";
import { createRouterClient } from "../src/client.js";
import { quoteCandidates } from "../src/quote-candidates.js";
import { prepareQuoteState } from "../src/quote-state.js";
import * as transactionLimits from "../src/transactions/size.js";
import type { PropAmmQuoteProvider } from "../src/types.js";
import { compileRouterMessage, decodeAddress, u64 } from "../src/utils.js";
import { now, setup } from "./fixtures/quotes.js";
import { withAccountCount, withPacketSize } from "./helpers/transaction-limits.js";

const config = NETWORKS.testnet;
const nowMs = Number(now) * 1000;
const maker = base58.encode(new Uint8Array(32).fill(0x22));

async function setupCandidates(rfqEnabled = true) {
  const fixture = setup();
  const request = { ...fixture.request, deadlineMs: nowMs + 30_000 };
  const candidates = findRoutes(buildRouteGraph(config, rfqEnabled ? ["btc-usd"] : []), request.inputMint, request.outputMint);
  const state = await prepareQuoteState(fixture.source, config, candidates);
  return { ...fixture, request, candidates, state, config, amount: request.amountIn, forOutput: false };
}

function providerFor(estimatedAmountOut: bigint, started?: () => void) {
  return { quoteExactIn: vi.fn(async (request: Parameters<PropAmmQuoteProvider["quoteExactIn"]>[0]) => {
    started?.();
    const sell = request.inputMint === mints.aBTC;
    return { quoteId: "candidate-rfq", quoteSigner: maker, estimatedAmountOut, terms: {
      side: sell ? "sell" as const : "buy" as const,
      baseAmount: sell ? request.amountIn : estimatedAmountOut + 17n,
      quoteAmount: sell ? estimatedAmountOut + 17n : request.amountIn,
      expiryMs: BigInt(nowMs + 20_000), nonce: 42n,
    } };
  }) };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(nowMs); });
afterEach(() => { vi.restoreAllMocks(); });

describe("graph candidate evaluation", () => {
  it("prefers CLAMM on equal output even when the RFQ candidate is listed first", async () => {
    const input = await setupCandidates();
    const swap = input.candidates[0]!.steps.find((step) => step.venue === "clamm")!;
    const expected = (await input.state.clamm(swap)).estimate(input.amount);
    const provider = providerFor(expected);
    const quote = await quoteCandidates({ ...input, candidates: [...input.candidates].reverse(), propAmmQuoteProviders: new Map([["btc-usd", provider]]) });
    expect(quote.hops[0]!.kind).toBe("clamm");
    expect(quote.estimatedAmountOut).toBe(expected);
    expect(quote.rfq).toBeUndefined();
    expect(provider.quoteExactIn).toHaveBeenCalledOnce();
  });

  it("starts the RFQ while the CLAMM pool read is still pending", async () => {
    const { source, accounts, request } = setup();
    let releasePool!: () => void;
    let signalRfq!: () => void;
    const poolGate = new Promise<void>((resolve) => { releasePool = resolve; });
    const rfqStarted = new Promise<void>((resolve) => { signalRfq = resolve; });
    source.getAccounts.mockImplementationOnce(async (keys) => {
      await poolGate;
      return keys.map((key) => accounts.get(key) ?? null);
    });
    const provider = providerFor(1_000_000_000_000n, signalRfq);
    const client = createRouterClient({ source, propAmmQuoteProvider: provider });
    const pending = client.quoteExactIn(request);
    try {
      await rfqStarted;
      expect(source.getAccounts).toHaveBeenCalledExactlyOnceWith([
        venues.clamm.address, mints.aBTC, mints.aUSD,
      ]);
    } finally {
      releasePool();
    }
    const quote = await pending;
    expect(quote).toMatchObject({ rfq: { quoteId: "candidate-rfq" } });
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
  });

  it("retains both original failures in candidate order when all venues fail", async () => {
    const input = await setupCandidates();
    const poolError = new Error("Ticks unavailable");
    const rfqError = new Error("Maker declined");
    input.source.getAccounts.mockRejectedValueOnce(poolError);
    const provider = providerFor(1_000n);
    provider.quoteExactIn.mockRejectedValueOnce(rfqError);
    const error: unknown = await quoteCandidates({ ...input, propAmmQuoteProviders: new Map([["btc-usd", provider]]) }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "NO_ROUTE", cause: expect.any(AggregateError) });
    if (!(error instanceof RouterSdkError) || !(error.cause instanceof AggregateError)) throw error;
    expect(error.cause.errors[0]).toBe(poolError);
    expect(error.cause.errors[1]).toBe(rfqError);
    expect(provider.quoteExactIn).toHaveBeenCalledOnce();
  });

  it("propagates the original error when the sole candidate fails", async () => {
    const input = await setupCandidates(false);
    const error = new Error("Tick transport failed");
    input.source.getAccounts.mockRejectedValueOnce(error);
    await expect(quoteCandidates(input)).rejects.toBe(error);
    expect(input.source.getAccounts).toHaveBeenCalledTimes(2);
  });

  it.each([
    { target: 101n, rates: [10n, 101n], expectedInput: 1n, expectedOutput: 101n },
    { target: 100n, rates: [10n, 11n], expectedInput: 10n, expectedOutput: 100n },
  ])("minimizes receive input with deterministic ties for target $target", async ({ target, rates, expectedInput, expectedOutput }) => {
    const input = await setupCandidates(false);
    const route = input.candidates[0]!;
    const swap = route.steps.find((step) => step.venue === "clamm")!;
    const prepared = await input.state.clamm(swap);
    // Synthetic parallel local paths exercise ranking beyond the current registry.
    const candidates = rates.map((rate) => ({ ...route, steps: [{ ...swap, id: rate.toString() }] }));
    const estimates = new Map(rates.map((rate) => [rate.toString(), vi.fn((value: bigint) => u64(value * rate))]));
    const state: typeof input.state = { ...input.state, clamm: vi.fn(async (step: Parameters<typeof input.state.clamm>[0]) => ({
      ...prepared, estimate: estimates.get(step.id)!,
    })) };
    input.source.getAccounts.mockClear();
    const provider = providerFor(1_000n);
    const quote = await quoteCandidates({ ...input, state, candidates, amount: target, forOutput: true, propAmmQuoteProviders: new Map([["btc-usd", provider]]) });
    expect(quote.amountIn).toBe(expectedInput);
    expect(quote.estimatedAmountOut).toBe(expectedOutput);
    expect(quote.minAmountOut).toBe(expectedOutput * 9950n / 10_000n);
    expect(quote.hops).toEqual([{
      kind: "clamm", inputMint: input.request.inputMint, outputMint: input.request.outputMint,
      amountIn: expectedInput, estimatedAmountOut: expectedOutput,
    }]);
    expect(input.source.getAccounts).not.toHaveBeenCalled();
    expect(provider.quoteExactIn).not.toHaveBeenCalled();
    for (const estimate of estimates.values()) expect(estimate.mock.calls.length).toBeLessThanOrEqual(66);
  });

  it("never requests an RFQ during receive sizing even if an RFQ path reaches the evaluator", async () => {
    const input = await setupCandidates();
    const provider = providerFor(1_000n);
    const quote = await quoteCandidates({ ...input, amount: 100_000n, forOutput: true, propAmmQuoteProviders: new Map([["btc-usd", provider]]) });
    expect(quote.estimatedAmountOut).toBeGreaterThanOrEqual(100_000n);
    expect(quote.hops[0]!.kind).toBe("clamm");
    expect(provider.quoteExactIn).not.toHaveBeenCalled();
    expect(input.source.getAccounts).toHaveBeenCalledTimes(2);
  });

  it("preserves validated request fields while shared state is fetched", async () => {
    const { client, source, accounts, request: base } = setup();
    const request = { ...base, outputMint: mints.primeBTC };
    const original = { ...request };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    source.getAccounts.mockImplementationOnce(async (keys) => {
      await gate;
      return keys.map((key) => accounts.get(key) ?? null);
    });
    const pending = client.quoteExactIn(request);
    Object.assign(request, { inputMint: "invalid", outputMint: "invalid", user: "invalid", amountIn: 0n, slippageBps: 10_000, deadlineMs: 0 });
    release();
    const quote = await pending;
    expect(quote).toMatchObject({
      inputMint: original.inputMint, outputMint: original.outputMint,
      amountIn: original.amountIn, deadlineMs: original.deadlineMs,
    });
    expect(quote.minAmountOut).toBe(quote.estimatedAmountOut * BigInt(10_000 - original.slippageBps) / 10_000n);
    expect(quote.instructions[0]!.accounts[0]!.pubkey).toEqual(decodeAddress(original.user));
    expect(source.getAccounts).toHaveBeenCalledOnce();
  });
});

describe.each(["clamm", "propamm"] as const)("transaction eligibility with preferred %s", (preferred) => {
  it.each([
    { limit: "bytes", boundary: 4096, rejected: false },
    { limit: "bytes", boundary: 4097, rejected: true },
    { limit: "accounts", boundary: 50, rejected: false },
    { limit: "accounts", boundary: 51, rejected: true },
  ])("checks synthetic $limit=$boundary before choosing the winner", async ({ limit, boundary, rejected }) => {
    const input = await setupCandidates();
    const provider = providerFor(preferred === "propamm" ? 1_000_000_000_000n : 1_000n);
    const check = transactionLimits.assertMessageLimits;
    const guard = vi.spyOn(transactionLimits, "assertMessageLimits").mockImplementation((message, label) => {
      const venue = message.header.num_required_signatures === 2 ? "propamm" : "clamm";
      expect(message.header.num_required_signatures).toBe(label === "PropAMM transaction" ? 2 : 1);
      expect(message.recent_blockhash).toEqual(new Uint8Array(32));
      const measured = venue === preferred
        ? limit === "bytes" ? withPacketSize(message, boundary) : withAccountCount(message, boundary)
        : message;
      return check(measured, label);
    });
    const quote = await quoteCandidates({ ...input, propAmmQuoteProviders: new Map([["btc-usd", provider]]) });
    const expected = rejected ? preferred === "clamm" ? "propamm" : "clamm" : preferred;
    expect(quote.hops[0]!.kind).toBe(expected);
    expect(quote.instructions).toHaveLength(expected === "propamm" ? 2 : 1);
    expect(quote.rfq).toEqual(expected === "propamm" ? { quoteId: "candidate-rfq" } : undefined);
    expect(guard).toHaveBeenCalledTimes(2); // Each bundle is measured once, including the RFQ builder's check.
    expect(provider.quoteExactIn).toHaveBeenCalledOnce();
    expect(input.source.getAccounts).toHaveBeenCalledTimes(2);
    const fetched = input.source.getAccounts.mock.calls.flatMap(([keys]) => keys);
    expect(new Set(fetched).size).toBeLessThan(50);
    // Only the measurement boundary was padded; native returned instructions still fit.
    expect(check(compileRouterMessage(quote.instructions, input.request.user, new Uint8Array(32))))
      .toBeLessThanOrEqual(transactionLimits.TRANSACTION_SIZE_LIMIT);
  });
});

describe("transaction eligibility errors", () => {
  it("retains account and byte failures when every competing candidate is over its limit", async () => {
    const input = await setupCandidates();
    const check = transactionLimits.assertMessageLimits;
    vi.spyOn(transactionLimits, "assertMessageLimits").mockImplementation((message, label) => check(
      message.header.num_required_signatures === 2 ? withPacketSize(message, 4097) : withAccountCount(message, 51), label,
    ));
    const error: unknown = await quoteCandidates({ ...input, propAmmQuoteProviders: new Map([["btc-usd", providerFor(1_000n)]]) })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "NO_ROUTE", cause: expect.any(AggregateError) });
    if (!(error instanceof RouterSdkError) || !(error.cause instanceof AggregateError)) throw error;
    expect(error.cause.errors.map((reason) => reason.code)).toEqual([
      "TRANSACTION_TOO_MANY_ACCOUNTS", "TRANSACTION_TOO_LARGE",
    ]);
  });

  it.each([
    { forOutput: false, limit: "bytes", code: "TRANSACTION_TOO_LARGE" },
    { forOutput: true, limit: "bytes", code: "TRANSACTION_TOO_LARGE" },
    { forOutput: false, limit: "accounts", code: "TRANSACTION_TOO_MANY_ACCOUNTS" },
    { forOutput: true, limit: "accounts", code: "TRANSACTION_TOO_MANY_ACCOUNTS" },
  ])("propagates a sole candidate's $limit error, receive sizing=$forOutput", async ({ forOutput, limit, code }) => {
    const input = await setupCandidates(false);
    const check = transactionLimits.assertMessageLimits;
    vi.spyOn(transactionLimits, "assertMessageLimits").mockImplementation((message, label) => check(
      limit === "bytes" ? withPacketSize(message, 4097) : withAccountCount(message, 51), label,
    ));
    await expect(quoteCandidates({ ...input, forOutput, amount: forOutput ? 100_000n : input.amount }))
      .rejects.toMatchObject({ code });
  });

  it.each([
    { forOutput: false, limit: "bytes", code: "TRANSACTION_TOO_LARGE" },
    { forOutput: true, limit: "accounts", code: "TRANSACTION_TOO_MANY_ACCOUNTS" },
  ])("checks vault-only public quotes against $limit, receive sizing=$forOutput", async ({ forOutput, limit, code }) => {
    const { client, source, request } = setup();
    const check = transactionLimits.assertMessageLimits;
    vi.spyOn(transactionLimits, "assertMessageLimits").mockImplementation((message, label) => check(
      limit === "bytes" ? withPacketSize(message, 4097) : withAccountCount(message, 51), label,
    ));
    const input = { ...request, outputMint: mints.primeBTC };
    const pending = forOutput ? client.quoteForOutput({ ...input, amountOut: 100_000n }) : client.quoteExactIn(input);
    await expect(pending).rejects.toMatchObject({ code });
    expect(source.getAccounts).toHaveBeenCalledOnce();
  });
});
