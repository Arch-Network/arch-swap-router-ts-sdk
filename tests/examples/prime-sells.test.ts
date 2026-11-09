import { base58, hex } from "@scure/base";
import { afterEach, expect, it, vi } from "vitest";
import { createDirectRfqProvider } from "../../examples/aeth-usd.js";
import { createRouterClient, MAINNET_PRIME_BTC_USD, MAINNET_PRIME_USD_USD } from "../../src/index.js";
import { decodeAddress, deriveAddress } from "../../src/utils.js";
import captured from "../fixtures/prime-sells/quotes.json" with { type: "json" };

afterEach(() => vi.restoreAllMocks());

it.each(captured)("validates a captured $symbol sell with only the built-in configuration", async fixture => {
  vi.spyOn(Date, "now").mockReturnValue(fixture.now);
  const market = fixture.symbol === "primeBTC" ? MAINNET_PRIME_BTC_USD : MAINNET_PRIME_USD_USD;
  const post = vi.fn(async (_url: string, _body: string) => JSON.stringify(fixture.wire));
  const source = { getAccounts: vi.fn(async () => { throw new Error("No vault reads for a forced direct sell"); }) };
  const router = createRouterClient({ network: "mainnet", source,
    directRfqQuoteProvider: createDirectRfqProvider("https://example.invalid/rfq", post) });
  const quote = await router.quoteExactIn({ inputMint: market.baseMint, outputMint: market.quoteMint,
    amountIn: BigInt(fixture.request.amount), user: base58.encode(hex.decode(fixture.request.user_pubkey)),
    slippageBps: fixture.request.slippage_bps, deadlineMs: fixture.now + 30_000, routePreference: "propamm" });
  expect(quote.hops.map(hop => hop.kind)).toEqual(["propamm"]);
  expect(quote.estimatedAmountOut).toBe(BigInt(fixture.wire.estimated_quote.quote_amount));
  expect(quote.rfq?.quoteId).toBe(fixture.wire.quote_id);
  expect(quote.instructions.length).toBeGreaterThan(0);
  expect(JSON.parse(post.mock.calls[0]![1])).toEqual(fixture.request);
  expect(source.getAccounts).not.toHaveBeenCalled();
  expect(market.baseVault).toBe(deriveAddress(market.programId, "vault", decodeAddress(market.config), decodeAddress(market.baseMint)));
  expect(market).not.toHaveProperty("treasuryAuthority");
  expect(market).not.toHaveProperty("bridgeProgramId");
});

it.each([MAINNET_PRIME_BTC_USD, MAINNET_PRIME_USD_USD])("does not request the unsupported Prime buy ABI for $baseMint", async market => {
  const post = vi.fn();
  const provider = createDirectRfqProvider("https://example.invalid/rfq", post);
  await expect(provider.quoteExactIn({ inputMint: market.quoteMint, outputMint: market.baseMint,
    amountIn: 100_000n, user: market.quoteSigner, deadlineMs: Date.now() + 30_000, slippageBps: 50 }))
    .rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
  expect(post).not.toHaveBeenCalled();
});
