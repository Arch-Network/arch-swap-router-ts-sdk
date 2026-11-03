import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET_AETH_USD as market } from "../src/index.js";
import { NETWORKS } from "../src/config/networks.js";
import { compileRouterMessage } from "../src/utils.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };
import nativeBuy from "./fixtures/aeth-usd/native-buy.json" with { type: "json" };
import { nativeAethBuyQuote, setupComposableAethBuy as setup, setU64 } from "./fixtures/composable-aeth.js";

const config = NETWORKS.mainnet;
const cases = [
  { input: config.mints.aUSD, kinds: ["propamm"], reads: 0, initial: 0, rfqOffset: 26 },
  { input: config.mints.primeUSD, kinds: ["vaultRedeem", "propamm"], reads: 1, initial: 4, rfqOffset: 27 },
  { input: config.mints.aBTC, kinds: ["clamm", "propamm"], reads: 2, initial: 3, rfqOffset: 45 },
  { input: config.mints.primeBTC, kinds: ["vaultRedeem", "clamm", "propamm"], reads: 2, initial: 6, rfqOffset: 46 },
] as const;

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

describe("native aETH buy routing", () => {
  it.each(cases)("quotes $input into aETH using native buys within $reads account reads", async ({ input, kinds, reads, initial, rfqOffset }) => {
    const state = setup(input);
    const prefix = input === market.quoteMint ? undefined
      : await createRouterClient({ network: "mainnet", source: state.source }).quoteExactIn({ ...state.request, outputMint: market.quoteMint });
    state.source.getAccounts.mockClear();
    const quote = await state.client.quoteExactIn(state.request);

    const amountIn = prefix?.estimatedAmountOut ?? state.request.amountIn;
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({
      ...state.request, inputMint: market.quoteMint, amountIn,
    });
    const rfq = await state.directRfqQuoteProvider.quoteExactIn.mock.results[0]!.value;
    const original = nativeAethBuyQuote(amountIn, state.request.slippageBps);
    expect(hex.encode(TransactionUtil.serialize(rfq.transaction))).toBe(hex.encode(TransactionUtil.serialize(original.transaction)));
    expect(quote).toMatchObject({ inputMint: input, outputMint: market.baseMint, amountIn: state.request.amountIn,
      estimatedAmountOut: rfq.estimatedAmountOut, minAmountOut: rfq.estimatedAmountOut * 9900n / 10_000n,
      deadlineMs: nativeBuy.expires_at_ms, rfq: { quoteId: rfq.quoteId } });
    expect(quote.hops.map(hop => hop.kind)).toEqual(kinds);
    if (prefix) expect(quote.hops.slice(0, -1)).toEqual(prefix.hops);
    expect(quote.hops.at(-1)).toMatchObject({ inputMint: market.quoteMint, outputMint: market.baseMint, amountIn });
    expect(state.propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expect(state.source.getAccounts).toHaveBeenCalledTimes(reads);
    if (reads > 0) expect(state.source.getAccounts.mock.calls[0]![0]).toHaveLength(initial);
    const keys = state.source.getAccounts.mock.calls.flatMap(([keys]) => keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(quote.instructions).toHaveLength(2);
    expect(quote.instructions[1]!.data.subarray(rfqOffset + 1, rfqOffset + 34))
      .toEqual(rfq.transaction.message.instructions[0]!.data.subarray(1, 34));
    const message = compileRouterMessage(quote.instructions, state.request.user, new Uint8Array(32));
    expect(message.header).toMatchObject({ num_required_signatures: 2, num_readonly_signed_accounts: 1 });
    expect(message.account_keys.slice(0, 2).map(base58.encode)).toEqual([state.request.user, market.quoteSigner]);
    expect(message.account_keys.length).toBeLessThanOrEqual(50);
    expect(TransactionUtil.serializedSize({ version: 0, message, signatures: [new Uint8Array(64), new Uint8Array(64)] })).toBeLessThanOrEqual(4096);
    expect(rfq.transaction.signatures).toEqual([]);
  });

  it("reaches all 20 directions without a BTC RFQ provider", () => {
    const state = setup();
    const { propAmmQuoteProvider: _unused, ...options } = state.options;
    expect(createRouterClient(options).supportedPairs).toHaveLength(20);
  });

  it.each(cases)("rejects expired requests and receive sizing before I/O from $input", async ({ input }) => {
    const state = setup(input);
    await expect(state.client.quoteExactIn({ ...state.request, deadlineMs: fixtures.now_ms })).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    await expect(state.client.quoteForOutput({ ...state.request, amountOut: 1n })).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    expect(state.source.getAccounts).not.toHaveBeenCalled();
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });

  it.each(["side", "quoted input", "actual input", "minimum", "expiry", "maker", "config", "base mint", "vault", "privileges", "signed", "extra instruction"])("rejects an invalid native buy: %s", async field => {
    const state = setup();
    const message = state.rfq.transaction.message;
    const trade = message.instructions[0]!;
    if (field === "side") trade.data[1] = 1;
    if (field === "quoted input") setU64(trade.data, 10, state.request.amountIn + 1n);
    if (field === "actual input") setU64(trade.data, 34, state.request.amountIn + 1n);
    if (field === "minimum") setU64(trade.data, 42, 1n);
    if (field === "expiry") setU64(trade.data, 18, state.rfq.expiresAtMs + 1n);
    if (field === "privileges") message.header.num_readonly_signed_accounts = 1;
    if (field === "signed") state.rfq.transaction.signatures.push(new Uint8Array(64));
    if (field === "extra instruction") message.instructions.push(trade);
    const position = field === "maker" ? 1 : field === "config" ? 0 : field === "base mint" ? 8 : field === "vault" ? 4 : undefined;
    if (position !== undefined) message.account_keys[trade.accounts[position]!] = new Uint8Array(32).fill(99);
    state.directRfqQuoteProvider.quoteExactIn.mockResolvedValue(state.rfq);
    await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
    expect(state.source.getAccounts).not.toHaveBeenCalled();
  });

  it("preserves full-u64 input and payout terms", async () => {
    const state = setup();
    const amountIn = (1n << 64n) - 1n;
    const quote = await state.client.quoteExactIn({ ...state.request, amountIn });
    expect(quote.amountIn).toBe(amountIn);
    expect(quote.estimatedAmountOut).toBe(amountIn * 2n / 5n);

    expect(new DataView(quote.instructions[1]!.data.buffer).getBigUint64(36, true)).toBe(amountIn);
  });

  it("clamps to an earlier caller deadline", async () => {
    const state = setup();
    const deadlineMs = fixtures.now_ms + 1000;
    expect((await state.client.quoteExactIn({ ...state.request, deadlineMs })).deadlineMs).toBe(deadlineMs);
  });

  it.each([config.mints.aBTC, config.mints.primeBTC])("fails tick loading before requesting a buy RFQ from %s", async input => {
    const state = setup(input);
    const read = state.source.getAccounts.getMockImplementation()!;
    const error = new Error("Ticks unavailable");
    state.source.getAccounts.mockImplementationOnce(read).mockRejectedValueOnce(error);
    await expect(state.client.quoteExactIn(state.request)).rejects.toBe(error);
    expect(state.source.getAccounts).toHaveBeenCalledTimes(2);
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });

  it("rejects an RFQ that expires in its provider", async () => {
    const state = setup();
    state.directRfqQuoteProvider.quoteExactIn.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(nativeBuy.expires_at_ms);
      return state.rfq;
    });
    await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
  });

  it("propagates a maker rejection without requesting another quote", async () => {
    const state = setup();
    const error = new Error("Insufficient aETH inventory");
    state.directRfqQuoteProvider.quoteExactIn.mockRejectedValueOnce(error);
    await expect(state.client.quoteExactIn(state.request)).rejects.toBe(error);
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
  });
});
