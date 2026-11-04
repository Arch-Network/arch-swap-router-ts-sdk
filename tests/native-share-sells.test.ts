import { base58 } from "@scure/base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET_AETH_USD as eth, MAINNET_RFQ_DEPLOYMENT, type DirectRfqMarket } from "../src/index.js";
import { NETWORKS } from "../src/config/networks.js";
import { decodeAddress, deriveAddress, deriveProgramAddress } from "../src/utils.js";
import { setupComposableAeth, setU64 } from "./fixtures/composable-aeth.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup(name: "btcVault" | "usdVault" = "usdVault") {
  const f = setupComposableAeth();
  const vault = NETWORKS.mainnet.venues[name];
  const { treasuryAuthority: _authority, bridgeProgramId: _bridge, ...inventory } = MAINNET_RFQ_DEPLOYMENT;
  const market: DirectRfqMarket = { sides: ["sell"], baseMint: vault.shareMint, quoteMint: vault.assetMint };
  const ata = (mint: string) => deriveProgramAddress([decodeAddress(fixtures.user), decodeAddress(eth.tokenProgramId), decodeAddress(mint)], eth.associatedTokenProgramId)[0];
  const custody = (mint: string) => deriveAddress(eth.programId, "vault", decodeAddress(eth.config), decodeAddress(mint));
  const replacements = new Map([[eth.baseMint, market.baseMint], [eth.quoteMint, market.quoteMint],
    [ata(eth.baseMint), ata(market.baseMint)], [ata(eth.quoteMint), ata(market.quoteMint)],
    [custody(eth.baseMint), custody(market.baseMint)], [custody(eth.quoteMint), custody(market.quoteMint)]]);
  f.rfq.transaction.message.account_keys = f.rfq.transaction.message.account_keys.map(key => decodeAddress(replacements.get(base58.encode(key)) ?? base58.encode(key)));
  const request = { ...f.request, inputMint: market.baseMint, outputMint: market.quoteMint, amountIn: 1_000_000n, slippageBps: 0 };
  const data = f.rfq.transaction.message.instructions[0]!.data;
  setU64(data, 2, request.amountIn); setU64(data, 34, request.amountIn);
  const reserve = await createRouterClient({ network: "mainnet", source: f.source }).quoteExactIn(request);
  const price = (amount: bigint) => { f.rfq.estimatedAmountOut = amount; setU64(data, 10, amount); setU64(data, 42, amount); };
  price(reserve.estimatedAmountOut + 1n);
  const options = { network: "mainnet" as const, source: f.source, directRfqDeployment: inventory, directRfqMarkets: [market], directRfqQuoteProvider: f.directRfqQuoteProvider };
  f.source.getAccounts.mockClear();
  return { ...f, options, market, request, price, reserve, client: createRouterClient(options) };
}

it.each(["btcVault", "usdVault"] as const)("compares both %s exits, with reserve winning ties", async name => {
  const f = await setup(name);
  expect((await f.client.quoteExactIn(f.request)).hops[0]!.kind).toBe("propamm");
  f.price(f.reserve.estimatedAmountOut);
  expect((await f.client.quoteExactIn(f.request)).hops[0]!.kind).toBe("vaultRedeem");
  f.price(f.reserve.estimatedAmountOut - 1n);
  expect((await f.client.quoteExactIn(f.request)).hops[0]!.kind).toBe("vaultRedeem");
});
it("forces a route without contacting its competitor", async () => {
  const f = await setup();
  await f.client.quoteExactIn({ ...f.request, routePreference: "propamm" });
  expect(f.source.getAccounts).not.toHaveBeenCalled();
  f.directRfqQuoteProvider.quoteExactIn.mockClear();
  await f.client.quoteExactIn({ ...f.request, routePreference: "vault" });
  expect(f.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
});
it("auto retains reserve on maker failure; forced maker never falls back", async () => {
  const f = await setup();
  f.directRfqQuoteProvider.quoteExactIn.mockRejectedValue(new Error("quote_input_limit_exceeded"));
  expect((await f.client.quoteExactIn(f.request)).hops[0]!.kind).toBe("vaultRedeem");
  await expect(f.client.quoteExactIn({ ...f.request, routePreference: "propamm" })).rejects.toThrow("quote_input_limit_exceeded");
});
it("auto retains maker when reserve reads fail; forced reserve never falls back", async () => {
  const f = await setup();
  f.source.getAccounts.mockRejectedValue(new Error("reserve unavailable"));
  expect((await f.client.quoteExactIn(f.request)).hops[0]!.kind).toBe("propamm");
  await expect(f.client.quoteExactIn({ ...f.request, routePreference: "vault" })).rejects.toThrow();
});
it("excludes an RFQ that expires while waiting for reserve", async () => {
  const f = await setup();
  const read = f.source.getAccounts.getMockImplementation()!;
  f.source.getAccounts.mockImplementation(async keys => {
    const accounts = await read(keys);
    vi.mocked(Date.now).mockReturnValue(Number(f.rfq.expiresAtMs));
    return accounts;
  });
  expect((await f.client.quoteExactIn(f.request)).hops[0]!.kind).toBe("vaultRedeem");
});
it("rejects substituted custody and keeps the valid reserve route", async () => {
  const f = await setup();
  f.rfq.transaction.message.instructions[0]!.accounts[4] = f.rfq.transaction.message.instructions[0]!.accounts[6]!;
  await expect(f.client.quoteExactIn({ ...f.request, routePreference: "propamm" })).rejects.toMatchObject({ code: "INVALID_RFQ" });
  expect((await f.client.quoteExactIn(f.request)).hops[0]!.kind).toBe("vaultRedeem");
});
it("rejects forced reverse buys and invalid preferences before requests", async () => {
  const f = await setup();
  await expect(f.client.quoteExactIn({ ...f.request, inputMint: f.request.outputMint, outputMint: f.request.inputMint, routePreference: "propamm" })).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
  await expect(f.client.quoteExactIn({ ...f.request, routePreference: "bad" as "auto" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(f.source.getAccounts).not.toHaveBeenCalled();
  expect(f.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
});

it("returns the maker when reserve reads never settle", async () => {
  const f = await setup();
  vi.useFakeTimers(); vi.setSystemTime(fixtures.now_ms);
  f.source.getAccounts.mockImplementation(() => new Promise(() => {}));
  const result = f.client.quoteExactIn(f.request);
  await vi.advanceTimersByTimeAsync(2000);
  expect((await result).hops[0]!.kind).toBe("propamm");
});
it("rejects a forced reserve quote that expires during its reads", async () => {
  const f = await setup();
  const read = f.source.getAccounts.getMockImplementation()!;
  f.source.getAccounts.mockImplementation(async keys => {
    const accounts = await read(keys);
    vi.mocked(Date.now).mockReturnValue(f.request.deadlineMs);
    return accounts;
  });
  await expect(f.client.quoteExactIn({ ...f.request, routePreference: "vault" })).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
});
