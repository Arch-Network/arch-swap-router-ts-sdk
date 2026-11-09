import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDirectRfqProvider } from "../../examples/aeth-usd.js";
import { createRouterClient, MAINNET_AHYPE_USD as market, type DirectRfqQuote } from "../../src/index.js";
import { NETWORKS } from "../../src/config/networks.js";
import { ahypeQuote, nativeAhypeBuyQuote, setupComposableAhype } from "../fixtures/composable-ahype.js";
import clock from "../fixtures/aeth-usd/transactions.json" with { type: "json" };

function wire(quote: DirectRfqQuote, side: "buy" | "sell", amountIn: bigint) {
  return { ...TransactionUtil.toNumberArray(quote.transaction), quote_id: quote.quoteId, expires_at_ms: Number(quote.expiresAtMs),
    estimated_quote: { base_amount: Number(side === "buy" ? quote.estimatedAmountOut : amountIn),
      quote_amount: Number(side === "buy" ? amountIn : quote.estimatedAmountOut) },
    ...(quote.treasuryAuthorization ? { treasury_authorization: { version: quote.treasuryAuthorization.version,
      min_amount_in: quote.treasuryAuthorization.minAmountIn.toString(), max_amount_in: quote.treasuryAuthorization.maxAmountIn.toString() } } : {}) };
}
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(clock.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

it.each(["buy", "sell"] as const)("uses aHYPE's mint and native amount in a %s HTTP request", async side => {
  const state = setupComposableAhype(market.quoteMint, side);
  const post = vi.fn(async (_url: string, _body: string) => JSON.stringify(wire(state.rfq, side, state.request.amountIn)));
  const provider = createDirectRfqProvider("https://example.invalid/rfq/", post);
  const client = createRouterClient({ ...state.options, directRfqQuoteProvider: provider });
  const quote = await client.quoteExactIn(state.request);
  expect(post).toHaveBeenCalledExactlyOnceWith("https://example.invalid/rfq/quote", expect.any(String));
  expect(JSON.parse(post.mock.calls[0]![1])).toEqual({ base_mint: hex.encode(base58.decode(market.baseMint)),
    quote_mint: hex.encode(base58.decode(market.quoteMint)), side, amount: Number(state.request.amountIn),
    user_pubkey: hex.encode(base58.decode(state.request.user)), slippage_bps: state.request.slippageBps });
  expect(quote.hops.map(hop => hop.kind)).toEqual([side === "buy" ? "treasuryMint" : "propamm"]);
  expect(quote.estimatedAmountOut).toBe(state.rfq.estimatedAmountOut);
});

it.each((["aBTC", "aUSD", "primeBTC", "primeUSD"] as const).map(symbol => NETWORKS.mainnet.mints[symbol]))("quotes aHYPE through HTTP after a prefix from %s", async inputMint => {
  const state = setupComposableAhype(inputMint, "buy");
  const post = vi.fn(async (_url: string, body: string) => {
    const amountIn = BigInt(JSON.parse(body).amount);
    return JSON.stringify(wire(ahypeQuote("buy", amountIn), "buy", amountIn));
  });
  const client = createRouterClient({ ...state.options, directRfqQuoteProvider: createDirectRfqProvider("https://example.invalid/rfq", post) });
  const quote = await client.quoteExactIn(state.request);
  expect(quote.hops.at(-1)!.kind).toBe("treasuryMint");
  expect(JSON.parse(post.mock.calls[0]![1]).amount).toBe(Number(quote.hops.at(-1)!.amountIn));
  expect(post).toHaveBeenCalledOnce();
});

it("decodes a native aHYPE buy expiry from instruction bytes without redundant metadata", async () => {
  const state = setupComposableAhype(market.quoteMint, "buy");
  const payload = wire(nativeAhypeBuyQuote(), "buy", state.request.amountIn);
  Reflect.deleteProperty(payload, "expires_at_ms");
  const provider = createDirectRfqProvider("https://example.invalid/rfq", async () => JSON.stringify(payload));
  const client = createRouterClient({ ...state.options, directRfqQuoteProvider: provider });
  expect((await client.quoteExactIn(state.request)).hops[0]!.kind).toBe("propamm");
});

it("rejects an HTTP aHYPE treasury response whose authorization was omitted", async () => {
  const state = setupComposableAhype(market.quoteMint, "buy");
  const payload = wire(state.rfq, "buy", state.request.amountIn);
  delete payload.treasury_authorization;
  const post = vi.fn(async () => JSON.stringify(payload));
  const client = createRouterClient({ ...state.options, directRfqQuoteProvider: createDirectRfqProvider("https://example.invalid/rfq", post) });
  await expect(client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
  expect(post).toHaveBeenCalledOnce();
});
