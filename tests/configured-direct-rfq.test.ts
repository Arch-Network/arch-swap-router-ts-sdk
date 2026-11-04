import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET_AETH_USD as eth, MAINNET_RFQ_DEPLOYMENT as deployment, type DirectRfqMarket, type DirectRfqQuote } from "../src/index.js";
import { decodeAddress, deriveAddress, deriveProgramAddress } from "../src/utils.js";
import { setupComposableAethBuy } from "./fixtures/composable-aeth.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };
import { nativeTransaction } from "./fixtures/aeth-usd/transactions.js";

const hype = { baseMint: "e1nbE9knw6fS1TwDixC3ZuXhDJpBf874WErswvqvMes", quoteMint: eth.quoteMint, sides: ["buy", "sell"] } satisfies DirectRfqMarket;
const ata = (market: DirectRfqMarket, mint = market.baseMint) => deriveProgramAddress([
  decodeAddress(fixtures.user), decodeAddress(eth.tokenProgramId), decodeAddress(mint),
], eth.associatedTokenProgramId)[0];
const vault = (market: DirectRfqMarket, mint = market.baseMint) => deriveAddress(deployment.programId, "vault", decodeAddress(deployment.config), decodeAddress(mint));

function setup(side: string, configured: DirectRfqMarket = hype) {
  const fixture = fixtures.cases.find(value => value.side === side)!;
  const transaction = nativeTransaction(fixture.transaction_hex);
  const replacements = new Map([
    [eth.baseMint, configured.baseMint], [eth.quoteMint, configured.quoteMint],
    [ata(eth, eth.quoteMint), ata(configured, configured.quoteMint)], [vault(eth, eth.quoteMint), vault(configured, configured.quoteMint)], [ata(eth), ata(configured)], [vault(eth), vault(configured)],
    ...["asset", "mint-authority"].map(seed => [deriveAddress(eth.bridgeProgramId, seed, decodeAddress(eth.baseMint)),
      deriveAddress(deployment.bridgeProgramId, seed, decodeAddress(configured.baseMint))]),
  ]);
  transaction.message.account_keys = transaction.message.account_keys.map(key => decodeAddress(replacements.get(base58.encode(key)) ?? base58.encode(key)));
  const request = { inputMint: side === "buy" ? configured.quoteMint : configured.baseMint,
    outputMint: side === "buy" ? configured.baseMint : configured.quoteMint, amountIn: BigInt(fixture.amount_in),
    slippageBps: 100, user: fixtures.user, deadlineMs: fixtures.now_ms + 60_000 };
  const quote: DirectRfqQuote = { transaction, quoteId: "configured-market", expiresAtMs: BigInt(fixture.expires_at_ms),
    estimatedAmountOut: BigInt(fixture.estimated_amount_out) };
  const source = { getAccounts: vi.fn(async () => { throw new Error("Unexpected account read"); }) };
  const provider = { quoteExactIn: vi.fn(async () => quote) };
  return { request, quote, source, provider };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

describe("configured direct markets", () => {
  it.each(["buy", "sell"])("validates a configured HYPE %s with unchanged native bytes", async side => {
    const { request, quote, source, provider } = setup(side);
    const router = createRouterClient({ network: "mainnet", source, directRfqQuoteProvider: provider, directRfqDeployment: deployment, directRfqMarkets: [hype] });
    const original = hex.encode(TransactionUtil.serialize(quote.transaction));
    const result = await router.quoteExactIn(request);
    expect(result.execution).not.toBe("serverTransaction");
    expect(hex.encode(TransactionUtil.serialize(quote.transaction))).toBe(original);
    expect(result.instructions.length).toBeGreaterThan(0);
    expect(source.getAccounts).not.toHaveBeenCalled();
    expect(router.supportedPairs).toContainEqual({ inputMint: hype.quoteMint, outputMint: hype.baseMint });
    expect(router.supportedPairs).not.toContainEqual({ inputMint: eth.quoteMint, outputMint: eth.baseMint });
  });

  it.each(["buy", "sell"])("rejects another market's accounts in a configured %s", async side => {
    const { request, quote, source, provider } = setup(side);
    const wrongAccount = side === "buy" ? deriveAddress(deployment.bridgeProgramId, "asset", decodeAddress(hype.baseMint)) : vault(hype);
    quote.transaction.message.account_keys = quote.transaction.message.account_keys.map(key => base58.encode(key) === wrongAccount ? decodeAddress(eth.baseMint) : key);
    const router = createRouterClient({ network: "mainnet", source, directRfqQuoteProvider: provider, directRfqDeployment: deployment, directRfqMarkets: [hype] });
    await expect(router.quoteExactIn(request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
  });

  it.each([eth, hype])("requires an explicit market entry for $baseMint", async market => {
    const { request, source, provider } = setup("buy", market);
    for (const markets of [undefined, []]) {
      const router = createRouterClient({ network: "mainnet", source, directRfqQuoteProvider: provider, directRfqDeployment: deployment,
        ...(markets === undefined ? {} : { directRfqMarkets: markets }) });
      await expect(router.quoteExactIn(request)).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    }
    expect(provider.quoteExactIn).not.toHaveBeenCalled();
  });

  it("copies trusted deployment data before asynchronous quoting", async () => {
    const { request, source, provider } = setup("buy");
    const configured = { ...deployment };
    const router = createRouterClient({ network: "mainnet", source, directRfqQuoteProvider: provider, directRfqDeployment: configured, directRfqMarkets: [hype] });
    configured.bridgeProgramId = eth.baseMint;
    await expect(router.quoteExactIn(request)).resolves.toMatchObject({ rfq: { quoteId: "configured-market" } });
  });

  it("keeps another ETH-input direct market available alongside an explicit ETH/USD direct market", async () => {
    const market = { ...hype, quoteMint: eth.baseMint };
    const { request, source, provider } = setup("buy", market);
    const router = createRouterClient({ network: "mainnet", source, directRfqQuoteProvider: provider, directRfqDeployment: deployment,
      directRfqMarkets: [eth, market] });
    await expect(router.quoteExactIn(request)).resolves.toMatchObject({ rfq: { quoteId: "configured-market" } });
    expect(source.getAccounts).not.toHaveBeenCalled();
  });

  it("rejects ambiguous pairs and malformed deployment keys at construction", () => {
    const { source, provider } = setup("buy");
    const options = { network: "mainnet" as const, source, directRfqQuoteProvider: provider, directRfqDeployment: deployment };
    expect(() => createRouterClient({ ...options, directRfqMarkets: [hype, hype] })).toThrow();
    expect(() => createRouterClient({ ...options, directRfqMarkets: [hype], directRfqDeployment: { ...deployment, config: "bad" } })).toThrow();
  });
});

it("requires a deployment for explicit markets", () => {
  expect(() => createRouterClient({ network: "mainnet", source: { getAccounts: async () => [] }, directRfqMarkets: [eth] })).toThrow("require a deployment");
});

it("quotes inventory buys without treasury identities and rejects treasury packets for that market", async () => {
  const { treasuryAuthority: _authority, bridgeProgramId: _bridge, ...inventory } = deployment;
  const { options, request, directRfqQuoteProvider } = setupComposableAethBuy();
  const router = createRouterClient({ ...options, directRfqDeployment: inventory, directRfqMarkets: [{ baseMint: eth.baseMint, quoteMint: eth.quoteMint, sides: ["buy"] }] });
  expect((await router.quoteExactIn(request)).hops.map(hop => hop.kind)).toEqual(["propamm"]);
  const treasury = setup("buy", eth).quote;
  directRfqQuoteProvider.quoteExactIn.mockResolvedValueOnce(treasury);
  await expect(router.quoteExactIn(request)).rejects.toThrow("Treasury execution is not configured");
  expect(router.supportedPairs).not.toContainEqual({ inputMint: eth.baseMint, outputMint: eth.quoteMint });
});
