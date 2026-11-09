import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAethUsdRfqProvider, prepareAethUsdSwap } from "../../examples/aeth-usd.js";
import { createRouterClient, MAINNET_AETH_USD as market, type DirectRfqQuote, type RuntimeTransaction } from "../../src/index.js";
import { NETWORKS } from "../../src/config/networks.js";
import fixtures from "../fixtures/aeth-usd/transactions.json" with { type: "json" };
import { nativeAethBuyQuote, setupComposableAethTreasuryBuy, treasuryAethBuyQuote } from "../fixtures/composable-aeth.js";

function wire(quote: DirectRfqQuote) {
  return { ...TransactionUtil.toNumberArray(quote.transaction), quote_id: quote.quoteId,
    expires_at_ms: Number(quote.expiresAtMs), estimated_quote: { base_amount: Number(quote.estimatedAmountOut), quote_amount: 1_000_000 },
    ...(quote.treasuryAuthorization === undefined ? {} : { treasury_authorization: {
      version: quote.treasuryAuthorization.version, min_amount_in: quote.treasuryAuthorization.minAmountIn.toString(),
      max_amount_in: quote.treasuryAuthorization.maxAmountIn.toString() } }) };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

it.each((["aBTC", "aUSD", "primeBTC", "primeUSD"] as const).map(symbol => NETWORKS.mainnet.mints[symbol]))("preserves issued treasury HTTP authorization after a prefix from %s", async input => {
  const state = setupComposableAethTreasuryBuy(input);
  const post = vi.fn(async (_url: string, body: string) => JSON.stringify(wire(treasuryAethBuyQuote(BigInt(JSON.parse(body).amount)))));
  const client = createRouterClient({ ...state.options,
    directRfqQuoteProvider: createAethUsdRfqProvider("https://example.invalid/rfq", post) });
  const quote = await client.quoteExactIn(state.request);
  expect(quote.hops.at(-1)!.kind).toBe("treasuryMint");
  expect(post).toHaveBeenCalledOnce();
  expect(JSON.parse(post.mock.calls[0]![1])).toMatchObject({ side: "buy", amount: Number(quote.hops.at(-1)!.amountIn) });
});

it("rejects an HTTP treasury quote missing authorization before opening the wallet or fetching a blockhash", async () => {
  const state = signingSetup();
  const payload = wire(state.rfq);
  delete payload.treasury_authorization;
  state.post.mockResolvedValue(JSON.stringify(payload));
  await expect(prepareAethUsdSwap(state.options, state.request)).rejects.toMatchObject({
    code: "INVALID_RFQ", message: "Treasury routing requires server-issued authorization.",
  });
  expect(state.post).toHaveBeenCalledOnce();
  expect(state.options.getRecentBlockhash).not.toHaveBeenCalled();
  expect(state.options.signMessage).not.toHaveBeenCalled();
  expect(state.options.confirm).not.toHaveBeenCalled();
});

it("decodes authorization strings above Number.MAX_SAFE_INTEGER losslessly", async () => {
  const state = setupComposableAethTreasuryBuy();
  const quote = treasuryAethBuyQuote();
  const payload = { ...wire(quote), treasury_authorization: { version: 1,
    min_amount_in: "9007199254740993", max_amount_in: "18446744073709551615" } };
  const provider = createAethUsdRfqProvider("https://example.invalid/rfq", async () => JSON.stringify(payload));
  expect((await provider.quoteExactIn(state.request)).treasuryAuthorization).toEqual({ version: 1,
    minAmountIn: 9007199254740993n, maxAmountIn: (1n << 64n) - 1n });
});

it.each([null, {}, { version: 2, min_amount_in: "1", max_amount_in: "2" },
  ...[0, 1, null, "0", "-1", "1.0", "01", "1e6", " 1", "18446744073709551616"].map(value =>
    ({ version: 1, min_amount_in: value, max_amount_in: "1005000" })),
])("rejects malformed HTTP authorization %#", async authorization => {
  const state = setupComposableAethTreasuryBuy();
  const payload = { ...wire(state.rfq), treasury_authorization: authorization };
  const provider = createAethUsdRfqProvider("https://example.invalid/rfq", async () => JSON.stringify(payload));
  await expect(provider.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
});

it("rejects treasury metadata attached to a native HTTP buy", async () => {
  const state = setupComposableAethTreasuryBuy();
  const payload = { ...wire(nativeAethBuyQuote()), treasury_authorization: { version: 1, min_amount_in: "995000", max_amount_in: "1005000" } };
  const provider = createAethUsdRfqProvider("https://example.invalid/rfq", async () => JSON.stringify(payload));
  await expect(provider.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
});

function signingSetup(bounded = false) {
  const state = setupComposableAethTreasuryBuy(market.quoteMint, bounded);
  const response = wire(state.rfq);
  const signature = new Uint8Array(64).fill(0x77);
  const post = vi.fn(async (url: string, _body: string) => url.endsWith("/quote")
    ? JSON.stringify(response) : JSON.stringify({ transaction_hash: "treasury-hash" }));
  const options = { serverUrl: "https://example.invalid", source: state.source, post,
    getRecentBlockhash: vi.fn(async () => new Uint8Array(32).fill(0x88)),
    signMessage: vi.fn(async (_message: RuntimeTransaction["message"]) => signature),
    confirm: vi.fn(async (_hash: string) => {}) };
  return { ...state, options, post, signature };
}

describe.each([false, true])("treasury signing example, bounded=%s", bounded => {
  it("submits the exact reviewed router message with only the user signature", async () => {
    const state = signingSetup(bounded);
    const original = hex.encode(TransactionUtil.serialize(state.rfq.transaction));
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    const message = prepared.transaction.message;
    expect(message.account_keys.slice(0, 2).map(base58.encode)).toEqual([state.request.user, market.treasuryAuthority]);
    expect(message.header).toMatchObject({ num_required_signatures: 2, num_readonly_signed_accounts: 0 });
    expect(state.options.signMessage).not.toHaveBeenCalled();
    expect(await prepared.submitAndConfirm()).toBe("treasury-hash");
    const submission = JSON.parse(state.post.mock.calls[1]![1]);
    expect(submission.quote_id).toBe(state.rfq.quoteId);
    expect(submission.message).toEqual(TransactionUtil.toNumberArray(prepared.transaction).message);
    expect(submission.signatures).toEqual([Array.from(state.signature)]);
    expect(state.options.confirm).toHaveBeenCalledExactlyOnceWith("treasury-hash");
    expect(hex.encode(TransactionUtil.serialize(state.rfq.transaction))).toBe(original);
  });

  it("rejects wallet mutation of treasury terms", async () => {
    const state = signingSetup(bounded);
    state.options.signMessage.mockImplementation(async message => {
      message.instructions[1]!.data[75] ^= 1;
      return state.signature;
    });
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    await expect(prepared.submitAndConfirm()).rejects.toMatchObject({ code: "MESSAGE_CHANGED" });
    expect(state.post).toHaveBeenCalledOnce();
  });

  it("rejects expiry while the wallet is signing", async () => {
    const state = signingSetup(bounded);
    const prepared = await prepareAethUsdSwap(state.options, state.request);
    state.options.signMessage.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(prepared.quote.deadlineMs);
      return state.signature;
    });
    await expect(prepared.submitAndConfirm()).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.post).toHaveBeenCalledOnce();
  });
});
