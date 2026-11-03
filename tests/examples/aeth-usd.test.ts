import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAethUsdRfqProvider, prepareAethUsdSwap } from "../../examples/aeth-usd.js";
import { createRouterClient, MAINNET_AETH_USD as market } from "../../src/index.js";
import { NETWORKS } from "../../src/config/networks.js";
import { setupComposableAeth } from "../fixtures/composable-aeth.js";
import fixtures from "../fixtures/aeth-usd/transactions.json" with { type: "json" };
import nativeBuy from "../fixtures/aeth-usd/native-buy.json" with { type: "json" };
import { nativeTransaction } from "../fixtures/aeth-usd/transactions.js";

function setup(side = "buy") {
  const fixture = side === "buy" ? nativeBuy : fixtures.cases.find(value => value.side === side)!;
  const transaction = nativeTransaction(fixture.transaction_hex);
  const wire = {
    ...TransactionUtil.toNumberArray(transaction), quote_id: `${side}-quote`, expires_at_ms: fixture.expires_at_ms,
    estimated_quote: {
      base_amount: Number(side === "buy" ? fixture.estimated_amount_out : fixture.amount_in),
      quote_amount: Number(side === "buy" ? fixture.amount_in : fixture.estimated_amount_out),
    },
  };
  const request = { inputMint: fixture.input_mint, outputMint: fixture.output_mint,
    amountIn: BigInt(fixture.amount_in), slippageBps: 100, user: fixtures.user, deadlineMs: fixtures.now_ms + 60_000 };
  const signature = new Uint8Array(64).fill(0x77);
  const post = vi.fn(async (url: string, _body: string) => url.endsWith("/rfq/quote")
    ? JSON.stringify(wire) : JSON.stringify({ transaction_hash: "mock-transaction-hash" }));
  const source = { getAccounts: vi.fn(async () => { throw new Error("Unexpected account read"); }) };
  const signMessage = vi.fn(async (_message: typeof transaction.message): Promise<Uint8Array> => signature);
  const confirm = vi.fn(async (_hash: string) => {});
  const blockhash = new Uint8Array(32).fill(0x44);
  const getRecentBlockhash = vi.fn(async (): Promise<Uint8Array> => blockhash);
  const options = { getRecentBlockhash, serverUrl: "http://example.invalid:3002/", source, post, signMessage, confirm };
  return { blockhash, getRecentBlockhash, fixture, transaction, wire, request, signature, options, post, source, signMessage, confirm };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

describe("aETH/aUSD HTTP, wallet and submission example (mocked)", () => {
  it.each([31, 33, "array"])("rejects an invalid compilation blockhash (%s) before opening the wallet", async length => {
    const state = setup();
    state.getRecentBlockhash.mockResolvedValue((length === "array" ? new Array(32).fill(0) : new Uint8Array(length as number)) as Uint8Array);
    await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(state.signMessage).not.toHaveBeenCalled();
    expect(state.post).toHaveBeenCalledOnce();
  });

  it("rejects an RFQ that expires while fetching the blockhash", async () => {
    const state = setup();
    state.getRecentBlockhash.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(state.fixture.expires_at_ms);
      return state.blockhash;
    });
    await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.signMessage).not.toHaveBeenCalled();
    expect(state.post).toHaveBeenCalledOnce();
  });

  it("compiles for the validated user if the caller mutates its request during blockhash loading", async () => {
    const state = setup();
    state.getRecentBlockhash.mockImplementation(async () => {
      state.request.user = market.quoteSigner;
      return state.blockhash;
    });
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    expect(base58.encode(prepared.transaction.message.account_keys[0]!)).toBe(fixtures.user);
    expect(prepared.quote.amountIn).toBe(BigInt(state.fixture.amount_in));
  });

  it("derives a native sell's expiry when the server omits the metadata", async () => {
    const state = setup("sell");
    Reflect.deleteProperty(state.wire, "expires_at_ms");
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    expect(prepared.quote.deadlineMs).toBe(state.fixture.expires_at_ms);
    expect(hex.encode(TransactionUtil.serialize(state.transaction))).toBe(state.fixture.transaction_hex);
    expect(state.signMessage).not.toHaveBeenCalled();
  });

  it.each([NETWORKS.mainnet.mints.aBTC, NETWORKS.mainnet.mints.primeBTC])("uses the metadata-free HTTP sell in a mixed route to %s", async outputMint => {
    const state = setup("sell");
    Reflect.deleteProperty(state.wire, "expires_at_ms");
    const mixed = setupComposableAeth(outputMint);
    const directRfqQuoteProvider = createAethUsdRfqProvider("https://vaults.veloxapi.net/propamm/rfq", state.post);
    const client = createRouterClient({ ...mixed.options, directRfqQuoteProvider });
    const quote = await client.quoteExactIn(mixed.request);
    expect(quote.hops.map(hop => hop.kind)).toEqual(outputMint === NETWORKS.mainnet.mints.aBTC
      ? ["propamm", "clamm"] : ["propamm", "clamm", "vaultMint"]);
    expect(quote.deadlineMs).toBe(state.fixture.expires_at_ms);
    expect(state.post).toHaveBeenCalledOnce();
    expect(state.post.mock.calls[0]![0]).toBe("https://vaults.veloxapi.net/propamm/rfq/quote");
    expect(JSON.parse(state.post.mock.calls[0]![1])).toMatchObject({ side: "sell", amount: Number(mixed.request.amountIn),
      base_mint: hex.encode(base58.decode(market.baseMint)), quote_mint: hex.encode(base58.decode(market.quoteMint)) });
    expect(mixed.source.getAccounts).toHaveBeenCalledTimes(2);
    expect(state.signMessage).not.toHaveBeenCalled();
  });

  it("reads full-u64 encoded sell expiry without a Number conversion", async () => {
    const state = setup("sell");
    Reflect.deleteProperty(state.wire, "expires_at_ms");
    const data = state.transaction.message.instructions[0]!.data;
    const expiry = (1n << 64n) - 1n;
    new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(18, expiry, true);
    state.wire.message = TransactionUtil.toNumberArray(state.transaction).message;
    const provider = createAethUsdRfqProvider("https://example.invalid/rfq", state.post);
    expect((await provider.quoteExactIn(state.request)).expiresAtMs).toBe(expiry);
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    expect(prepared.quote.deadlineMs).toBe(state.request.deadlineMs);
  });

  it("rejects treasury buys before fetching a blockhash or opening the wallet", async () => {
    const state = setup("buy");
    Object.assign(state.wire, TransactionUtil.toNumberArray(nativeTransaction(fixtures.cases.find(value => value.side === "buy")!.transaction_hex)));
    await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
  });

  it.each(["mismatch", "null", "truncated", "extra instruction", "wrong program", "wrong side"])("rejects invalid sell expiry source: %s", async field => {
    const state = setup("sell");
    const trade = state.wire.message.instructions[0]!;
    if (field === "mismatch") state.wire.expires_at_ms++;
    else if (field === "null") Reflect.set(state.wire, "expires_at_ms", null);
    else {
      Reflect.deleteProperty(state.wire, "expires_at_ms");
      if (field === "truncated") trade.data = trade.data.slice(0, 25);
      if (field === "extra instruction") state.wire.message.instructions.push(trade);
      if (field === "wrong program") trade.program_id_index = 0;
      if (field === "wrong side") trade.data[1] = 0;
    }
    await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
    expect(state.signMessage).not.toHaveBeenCalled();
  });

  it.each(["buy", "sell"])("compiles, signs, submits and confirms a %s router message while preserving the RFQ", async side => {
    const state = setup(side);
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    expect(state.signMessage).not.toHaveBeenCalled(); // The quote is available for review first.
    expect(prepared.quote.instructions).toHaveLength(2);
    expect(prepared.transaction.message.recent_blockhash).toEqual(state.blockhash);
    expect(state.getRecentBlockhash).toHaveBeenCalledOnce();
    expect(prepared.quote.minAmountOut).toBe(BigInt(state.fixture.min_amount_out));
    expect(await prepared.submitAndConfirm()).toBe("mock-transaction-hash");
    expect(state.post.mock.calls[0]![0]).toBe("http://example.invalid:3002/rfq/quote");
    expect(JSON.parse(state.post.mock.calls[0]![1])).toEqual({
      base_mint: hex.encode(base58.decode(market.baseMint)), quote_mint: hex.encode(base58.decode(market.quoteMint)),
      side, amount: Number(state.fixture.amount_in), user_pubkey: hex.encode(base58.decode(fixtures.user)), slippage_bps: 100,
    });
    expect(state.signMessage.mock.calls[0]![0]).toBe(prepared.transaction.message);
    expect(state.post.mock.calls[1]![0]).toBe("http://example.invalid:3002/rfq/swap");
    expect(JSON.parse(state.post.mock.calls[1]![1])).toEqual({ quote_id: state.wire.quote_id,
      ...TransactionUtil.toNumberArray({ ...prepared.transaction, signatures: [state.signature] }) });
    expect(hex.encode(TransactionUtil.serialize(state.transaction))).toBe(state.fixture.transaction_hex);
    expect(prepared.transaction.signatures).toEqual([]);
    expect(state.signMessage).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledTimes(2);
    expect(state.confirm.mock.calls).toEqual([["mock-transaction-hash"]]);
    expect(state.source.getAccounts).not.toHaveBeenCalled();
  });

  it.each(["buy", "sell"])("preserves a full u64 %s input in the HTTP numeric literal", async side => {
    const state = setup(side);
    state.request.amountIn = (1n << 64n) - 1n;
    const data = state.transaction.message.instructions[0]!.data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (const offset of side === "buy" ? [10, 34] : [2, 34]) view.setBigUint64(offset, state.request.amountIn, true);
    state.wire.message = TransactionUtil.toNumberArray(state.transaction).message;
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    expect(state.post.mock.calls[0]![1]).toContain('"amount":18446744073709551615');
    expect(prepared.quote.amountIn).toBe(state.request.amountIn);
    await prepared.submitAndConfirm();
    expect(JSON.parse(state.post.mock.calls[1]![1]).message).toEqual(TransactionUtil.toNumberArray(prepared.transaction).message);
  });

  it.each(["buy", "sell"])("rejects unsafe numeric %s metadata before wallet signing", async side => {
    for (const field of ["expiry", "output"]) {
      const state = setup(side);
      if (field === "expiry") state.wire.expires_at_ms = Number.MAX_SAFE_INTEGER + 1;
      else if (side === "buy") state.wire.estimated_quote.base_amount = Number.MAX_SAFE_INTEGER + 1;
      else state.wire.estimated_quote.quote_amount = Number.MAX_SAFE_INTEGER + 1;
      await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
      expect(state.signMessage).not.toHaveBeenCalled();
      expect(state.post).toHaveBeenCalledTimes(1);
    }
  });

  const malformed: [string, (state: ReturnType<typeof setup>) => void][] = [
    ["negative byte", state => { state.wire.message.account_keys[0]![0] = -1; }],
    ["overflowing byte", state => { state.wire.message.recent_blockhash[0] = 256; }],
    ["fractional data byte", state => { state.wire.message.instructions[0]!.data[0] = 0.5; }],
    ["fractional account index", state => { state.wire.message.instructions[0]!.accounts[0] = 0.5; }],
    ["short public key", state => { state.wire.message.account_keys[0]!.pop(); }],
    ["short blockhash", state => { state.wire.message.recent_blockhash.pop(); }],
    ["missing message", state => { Reflect.deleteProperty(state.wire, "message"); }],
    ["missing estimate", state => { Reflect.deleteProperty(state.wire, "estimated_quote"); }],
    ["non-array instructions", state => { Reflect.set(state.wire.message, "instructions", {}); }],
    ["missing quote ID", state => { Reflect.deleteProperty(state.wire, "quote_id"); }],
  ];
  it.each(malformed)("rejects malformed wire response: %s", async (_, mutate) => {
    const state = setup();
    mutate(state);
    await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
    expect(state.signMessage).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before signing", async () => {
    const state = setup();
    state.post.mockResolvedValue("not JSON");
    await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
    expect(state.signMessage).not.toHaveBeenCalled();
  });

  it.each(["buy", "sell"])("uses SDK validation to reject a tampered %s before signing", async side => {
    const state = setup(side);
    state.wire.message.instructions[0]!.data[0] = 255;
    await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
    expect(state.signMessage).not.toHaveBeenCalled();
    expect(state.post).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported pairs without HTTP or wallet calls", async () => {
    const state = setup();
    await expect(prepareAethUsdSwap(state.options, { ...state.request, outputMint: market.quoteMint }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    expect(state.post).not.toHaveBeenCalled();
    expect(state.signMessage).not.toHaveBeenCalled();
  });

  it.each(["buy", "sell"])("checks the %s deadline before opening the wallet", async side => {
    const state = setup(side);
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    vi.mocked(Date.now).mockReturnValue(prepared.quote.deadlineMs);
    await expect(prepared.submitAndConfirm()).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.signMessage).not.toHaveBeenCalled();
    expect(state.post).toHaveBeenCalledTimes(1);
  });

  it.each(["buy", "sell"])("checks the earlier %s client deadline again after wallet signing", async side => {
    const state = setup(side);
    state.request.deadlineMs = fixtures.now_ms + 5000;
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    state.signMessage.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(state.request.deadlineMs);
      return state.signature;
    });
    await expect(prepared.submitAndConfirm()).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.signMessage).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it.each(["buy", "sell"])("retries an uncertain %s submission with exactly the same signed body and quote ID", async side => {
    const state = setup(side);
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    const uncertain = new Error("Response lost after submission");
    state.post.mockRejectedValueOnce(uncertain);
    await expect(prepared.submitAndConfirm()).rejects.toBe(uncertain);
    expect(state.confirm).not.toHaveBeenCalled();
    const submittedMessage = JSON.parse(state.post.mock.calls[1]![1]).message;
    // Even later changes to exposed objects must not change the cached retry body.
    prepared.transaction.message.recent_blockhash.fill(0x88);
    state.signature.fill(0x99);
    expect(await prepared.submitAndConfirm()).toBe("mock-transaction-hash");
    expect(state.post.mock.calls[2]![1]).toBe(state.post.mock.calls[1]![1]);
    expect(JSON.parse(state.post.mock.calls[2]![1]).quote_id).toBe(state.wire.quote_id);
    expect(JSON.parse(state.post.mock.calls[2]![1]).message).toEqual(submittedMessage);
    expect(state.signMessage).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledTimes(3); // One quote, two explicit submission attempts.
  });

  it("rejects an expired uncertain retry without re-signing or silently getting another quote", async () => {
    const state = setup();
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    state.post.mockRejectedValueOnce(new Error("Uncertain submission"));
    await expect(prepared.submitAndConfirm()).rejects.toThrow("Uncertain submission");
    vi.mocked(Date.now).mockReturnValue(prepared.quote.deadlineMs);
    await expect(prepared.submitAndConfirm()).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.post).toHaveBeenCalledTimes(2);
    expect(state.signMessage).toHaveBeenCalledTimes(1);
  });

  it("retries confirmation of a known hash after expiry without re-submitting", async () => {
    const state = setup();
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    const uncertain = new Error("Confirmation unavailable");
    state.confirm.mockRejectedValueOnce(uncertain);
    await expect(prepared.submitAndConfirm()).rejects.toBe(uncertain);
    vi.mocked(Date.now).mockReturnValue(prepared.quote.deadlineMs + 1);
    expect(await prepared.submitAndConfirm()).toBe("mock-transaction-hash");
    expect(state.confirm).toHaveBeenCalledTimes(2);
    expect(state.post).toHaveBeenCalledTimes(2);
    expect(state.signMessage).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent submission attempts instead of opening the wallet twice", async () => {
    const state = setup();
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    const first = prepared.submitAndConfirm(), second = prepared.submitAndConfirm();
    expect(first).toBe(second);
    await expect(first).resolves.toBe("mock-transaction-hash");
    expect(state.signMessage).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledTimes(2);
    expect(state.confirm).toHaveBeenCalledTimes(1);
  });

  it.each([63, 65, "array"])("rejects an invalid wallet signature (%s)", async length => {
    const state = setup();
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    state.signMessage.mockResolvedValue((length === "array" ? new Array(64).fill(0) : new Uint8Array(length as number)) as Uint8Array);
    await expect(prepared.submitAndConfirm()).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it.each(["before signing", "during signing"])("rejects message mutation %s", async phase => {
    const state = setup();
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    if (phase === "before signing") prepared.transaction.message.recent_blockhash.fill(0x88);
    else state.signMessage.mockImplementation(async message => { message.recent_blockhash.fill(0x88); return state.signature; });
    await expect(prepared.submitAndConfirm()).rejects.toMatchObject({ code: "MESSAGE_CHANGED" });
    expect(state.post).toHaveBeenCalledTimes(1);
  });

  it("propagates wallet rejection without submitting", async () => {
    const state = setup();
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    const error = new Error("Wallet declined");
    state.signMessage.mockRejectedValue(error);
    await expect(prepared.submitAndConfirm()).rejects.toBe(error);
    expect(state.post).toHaveBeenCalledTimes(1);
  });

  it("propagates server quote rejection without opening the wallet or reading accounts", async () => {
    const state = setup();
    const error = new Error("RFQ HTTP rejection");
    state.post.mockRejectedValue(error);
    await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toBe(error);
    expect(state.signMessage).not.toHaveBeenCalled();
    expect(state.source.getAccounts).not.toHaveBeenCalled();
  });

  it.each([null, {}, { transaction_hash: "" }, { transaction_hash: 42 }])("retains the signed body after malformed submission response %#", async response => {
    const state = setup();
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    state.post.mockResolvedValueOnce(JSON.stringify(response));
    await expect(prepared.submitAndConfirm()).rejects.toMatchObject({ code: "INVALID_SUBMISSION_RESPONSE" });
    await expect(prepared.submitAndConfirm()).resolves.toBe("mock-transaction-hash");
    expect(state.post.mock.calls[2]![1]).toBe(state.post.mock.calls[1]![1]);
    expect(state.signMessage).toHaveBeenCalledTimes(1);
  });
});
