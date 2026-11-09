import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET_AHYPE_USD as market, MAINNET_AETH_USD } from "../src/index.js";
import { NETWORKS } from "../src/config/networks.js";
import { compileRouterMessage, decodeAddress, deriveAddress } from "../src/utils.js";
import { setupComposableAhype as setup } from "./fixtures/composable-ahype.js";
import { nativeAethBuyQuote, setupComposableAeth, treasuryAethBuyQuote } from "./fixtures/composable-aeth.js";
import clock from "./fixtures/aeth-usd/transactions.json" with { type: "json" };

const config = NETWORKS.mainnet;
const cases = [
  { counter: config.mints.aUSD, reads: 0, prefix: [], suffix: [] },
  { counter: config.mints.primeUSD, reads: 1, prefix: ["vaultRedeem"], suffix: ["vaultMint"] },
  { counter: config.mints.aBTC, reads: 2, prefix: ["clamm"], suffix: ["clamm"] },
  { counter: config.mints.primeBTC, reads: 2, prefix: ["vaultRedeem", "clamm"], suffix: ["clamm", "vaultMint"] },
] as const;
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(clock.now_ms); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("exposes 28 unique pairs and excludes both two-RFQ ETH/HYPE directions", async () => {
  const state = setup();
  expect(state.client.supportedPairs).toHaveLength(28);
  expect(new Set(state.client.supportedPairs.map(pair => `${pair.inputMint}:${pair.outputMint}`)).size).toBe(28);
  for (const { counter } of cases) {
    expect(state.client.supportedPairs).toContainEqual({ inputMint: market.baseMint, outputMint: counter });
    expect(state.client.supportedPairs).toContainEqual({ inputMint: counter, outputMint: market.baseMint });
  }
  for (const [inputMint, outputMint] of [[market.baseMint, MAINNET_AETH_USD.baseMint], [MAINNET_AETH_USD.baseMint, market.baseMint]]) {
    expect(state.client.supportedPairs).not.toContainEqual({ inputMint, outputMint });
    await expect(state.client.quoteExactIn({ ...state.request, inputMint: inputMint!, outputMint: outputMint! }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
  }
  expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  expect(state.source.getAccounts).not.toHaveBeenCalled();
});

for (const side of ["buy", "sell"] as const) {
  it.each(cases)(`quotes an aHYPE ${side} against $counter with one RFQ and $reads reads`, async ({ counter, reads, prefix, suffix }) => {
    const state = setup(counter, side);
    const quote = await state.client.quoteExactIn(state.request);
    expect(quote.hops.map(hop => hop.kind)).toEqual(side === "buy" ? [...prefix, "treasuryMint"] : ["propamm", ...suffix]);
    const nativeHop = side === "buy" ? quote.hops.at(-1)! : quote.hops[0]!;
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({ ...state.request,
      inputMint: nativeHop.inputMint, outputMint: nativeHop.outputMint, amountIn: nativeHop.amountIn });
    expect(state.propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expect(state.source.getAccounts).toHaveBeenCalledTimes(reads);
    const keys = state.source.getAccounts.mock.calls.flatMap(([keys]) => keys);
    expect(new Set(keys).size).toBe(keys.length);
    const rfq = await state.directRfqQuoteProvider.quoteExactIn.mock.results[0]!.value;
    const original = hex.encode(TransactionUtil.serialize(rfq.transaction));
    expect(quote.rfq).toEqual({ quoteId: rfq.quoteId });
    expect(quote.minAmountOut).toBe(quote.estimatedAmountOut * 9900n / 10_000n);
    const message = compileRouterMessage(quote.instructions, state.request.user, new Uint8Array(32));
    expect(message.account_keys.slice(0, 2).map(base58.encode)).toEqual([state.request.user, side === "buy" ? market.treasuryAuthority : market.quoteSigner]);
    expect(message.header).toMatchObject({ num_required_signatures: 2, num_readonly_signed_accounts: side === "buy" ? 0 : 1 });
    expect(message.account_keys.length).toBeLessThanOrEqual(50);
    expect(TransactionUtil.serializedSize({ version: 0, message, signatures: [new Uint8Array(64), new Uint8Array(64)] })).toBeLessThanOrEqual(4096);
    if (side === "buy") {
      const data = quote.instructions[1]!.data;
      const offset = 26 + prefix.reduce((total, kind) => total + (kind === "clamm" ? 19 : 1), 0);
      const view = new DataView(data.buffer, data.byteOffset + offset, 73);
      expect(data[offset]).toBe(4);
      expect([33, 41, 49, 57, 65].map(index => view.getBigUint64(index, true))).toEqual([
        nativeHop.amountIn, rfq.estimatedAmountOut, rfq.treasuryAuthorization!.minAmountIn, rfq.treasuryAuthorization!.maxAmountIn, rfq.expiresAtMs,
      ]);
      expect(message.account_keys.map(base58.encode)).toContain(deriveAddress(market.bridgeProgramId, "asset", decodeAddress(market.baseMint)));
      expect(message.account_keys.map(base58.encode)).not.toContain(deriveAddress(market.bridgeProgramId, "asset", decodeAddress(MAINNET_AETH_USD.baseMint)));
    } else {
      expect(message.account_keys.map(base58.encode)).toContain(market.baseVault);
      expect(message.account_keys.map(base58.encode)).not.toContain(MAINNET_AETH_USD.baseVault);
    }
    expect(hex.encode(TransactionUtil.serialize(rfq.transaction))).toBe(original);
  });

  it.each(cases)(`rejects aHYPE ${side} receive sizing and expired requests before I/O against $counter`, async ({ counter }) => {
    const state = setup(counter, side);
    await expect(state.client.quoteForOutput({ ...state.request, amountOut: 1n })).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    await expect(state.client.quoteExactIn({ ...state.request, deadlineMs: clock.now_ms })).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.source.getAccounts).not.toHaveBeenCalled();
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });

  it(`disables aHYPE ${side} without a mainnet direct provider`, async () => {
    const state = setup(market.quoteMint, side);
    for (const network of ["mainnet", "testnet"] as const) {
      const client = createRouterClient({ network, source: state.source, ...(network === "testnet" ? { directRfqQuoteProvider: state.directRfqQuoteProvider } : {}) });
      expect(client.supportedPairs).toHaveLength(12);
      await expect(client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    }
    expect(state.source.getAccounts).not.toHaveBeenCalled();
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });
}

it.each(cases)("supports native aHYPE buys from $counter", async ({ counter, prefix }) => {
  const state = setup(counter, "buy", true, true);
  const quote = await state.client.quoteExactIn(state.request);
  expect(quote.hops.map(hop => hop.kind)).toEqual([...prefix, "propamm"]);
  expect(quote.hops.at(-1)!.outputMint).toBe(market.baseMint);
});

it.each(cases)("rejects missing treasury authorization from $counter without retrying", async ({ counter }) => {
  const state = setup(counter, "buy");
  const issue = state.directRfqQuoteProvider.quoteExactIn.getMockImplementation()!;
  state.directRfqQuoteProvider.quoteExactIn.mockImplementation(async request => {
    const { treasuryAuthorization: _authorization, ...quote } = await issue(request);
    return quote;
  });
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ", message: "Treasury routing requires server-issued authorization." });
  expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
});

it.each(["treasury buy", "native buy", "sell"])("rejects an aETH %s packet for an aHYPE request", async mode => {
  const side = mode === "sell" ? "sell" : "buy";
  const state = setup(market.quoteMint, side);
  const quote = mode === "treasury buy" ? treasuryAethBuyQuote() : mode === "native buy" ? nativeAethBuyQuote() : setupComposableAeth().rfq;
  state.directRfqQuoteProvider.quoteExactIn.mockResolvedValue(quote);
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
});

it("times out an aHYPE provider after two seconds without retrying", async () => {
  vi.useFakeTimers();
  const state = setup();
  state.directRfqQuoteProvider.quoteExactIn.mockImplementation(() => new Promise(() => {}));
  const pending = expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "RFQ_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(2000);
  await pending;
  expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
