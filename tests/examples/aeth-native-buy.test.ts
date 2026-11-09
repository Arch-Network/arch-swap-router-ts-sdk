import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAethUsdRfqProvider } from "../../examples/aeth-usd.js";
import { createRouterClient, MAINNET_AETH_USD as market, type DirectRfqQuote } from "../../src/index.js";
import { NETWORKS } from "../../src/config/networks.js";
import native from "../fixtures/aeth-usd/native-buy.json" with { type: "json" };
import { nativeAethBuyQuote, setupComposableAethBuy, setU64 } from "../fixtures/composable-aeth.js";

function wire(quote: DirectRfqQuote) {
  return { ...TransactionUtil.toNumberArray(quote.transaction), quote_id: quote.quoteId,
    estimated_quote: { base_amount: Number(quote.estimatedAmountOut), quote_amount: 1_000_000 } };
}
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(native.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

it.each((["aBTC", "aUSD", "primeBTC", "primeUSD"] as const).map(symbol => NETWORKS.mainnet.mints[symbol]))("decodes a metadata-free native HTTP buy after a prefix from %s", async inputMint => {
  const state = setupComposableAethBuy(inputMint);
  let response: DirectRfqQuote | undefined;
  let original: string | undefined;
  const post = vi.fn(async (_url: string, body: string) => {
    const request = JSON.parse(body);
    response = nativeAethBuyQuote(BigInt(request.amount), request.slippage_bps);
    original = hex.encode(TransactionUtil.serialize(response.transaction));
    return JSON.stringify(wire(response));
  });
  const provider = createAethUsdRfqProvider("https://vaults.veloxapi.net/propamm/rfq", post);
  const client = createRouterClient({ ...state.options, directRfqQuoteProvider: provider });
  const quote = await client.quoteExactIn(state.request);
  expect(quote.hops.at(-1)).toMatchObject({ kind: "propamm", inputMint: market.quoteMint, outputMint: market.baseMint });
  expect(quote.estimatedAmountOut).toBe(response!.estimatedAmountOut);
  expect(quote.deadlineMs).toBe(native.expires_at_ms);
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0]![0]).toBe("https://vaults.veloxapi.net/propamm/rfq/quote");
  expect(JSON.parse(post.mock.calls[0]![1])).toMatchObject({
    side: "buy", amount: Number(quote.hops.at(-1)!.amountIn), slippage_bps: 100,
    base_mint: hex.encode(base58.decode(market.baseMint)), quote_mint: hex.encode(base58.decode(market.quoteMint)),
    user_pubkey: hex.encode(base58.decode(state.request.user)),
  });
  expect(hex.encode(TransactionUtil.serialize(response!.transaction))).toBe(original);
});

it("preserves full-u64 input in the HTTP buy literal", async () => {
  const state = setupComposableAethBuy();
  const amountIn = (1n << 64n) - 1n;
  for (const offset of [10, 34]) setU64(state.rfq.transaction.message.instructions[0]!.data, offset, amountIn);
  const post = vi.fn(async (_url: string, _body: string) => JSON.stringify(wire(state.rfq)));
  const provider = createAethUsdRfqProvider("https://example.invalid/rfq", post);
  const client = createRouterClient({ ...state.options, directRfqQuoteProvider: provider });
  expect((await client.quoteExactIn({ ...state.request, amountIn })).amountIn).toBe(amountIn);
  expect(post.mock.calls[0]![1]).toContain('"amount":18446744073709551615');
});

it("reads full-u64 native buy expiry from bytes and clamps to the caller deadline", async () => {
  const state = setupComposableAethBuy();
  const expiresAtMs = (1n << 64n) - 1n;
  setU64(state.rfq.transaction.message.instructions[0]!.data, 18, expiresAtMs);
  const post = async () => JSON.stringify(wire(state.rfq));
  const provider = createAethUsdRfqProvider("https://example.invalid/rfq", post);
  expect((await provider.quoteExactIn(state.request)).expiresAtMs).toBe(expiresAtMs);
  const client = createRouterClient({ ...state.options, directRfqQuoteProvider: provider });
  expect((await client.quoteExactIn(state.request)).deadlineMs).toBe(state.request.deadlineMs);
});

it.each(["mismatch", "unsafe expiry", "unsafe output", "wrong side"])("rejects invalid native buy HTTP response: %s", async field => {
  const state = setupComposableAethBuy();
  const response = wire(state.rfq);
  if (field === "mismatch") Reflect.set(response, "expires_at_ms", native.expires_at_ms + 1);
  if (field === "unsafe expiry") Reflect.set(response, "expires_at_ms", Number.MAX_SAFE_INTEGER + 1);
  if (field === "unsafe output") response.estimated_quote.base_amount = Number.MAX_SAFE_INTEGER + 1;
  if (field === "wrong side") response.message.instructions[0]!.data[1] = 1;
  const provider = createAethUsdRfqProvider("https://example.invalid/rfq", async () => JSON.stringify(response));
  const client = createRouterClient({ ...state.options, directRfqQuoteProvider: provider });
  await expect(client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
  expect(state.source.getAccounts).not.toHaveBeenCalled();
});
