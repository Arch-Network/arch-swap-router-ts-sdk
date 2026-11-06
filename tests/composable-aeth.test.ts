import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET_AETH_USD as market } from "../src/index.js";
import { NETWORKS } from "../src/config/networks.js";
import { buildRouteGraph, findRoutes, supportedPairs } from "../src/config/routes.js";
import { compileRouterMessage, decodeAddress, deriveAddress } from "../src/utils.js";
import * as limits from "../src/transactions/size.js";
import { withAccountCount, withPacketSize } from "./helpers/transaction-limits.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };
import { nativeTransaction } from "./fixtures/aeth-usd/transactions.js";
import { setupComposableAeth as setup, setU64 } from "./fixtures/composable-aeth.js";

const config = NETWORKS.mainnet;
const usd = config.venues.usdVault;
const reserve = deriveAddress(config.programs.vaultProgramId, "reserve", decodeAddress(usd.shareMint));
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("composable aETH sell discovery", () => {
  it("registers distinct market edges even when BTC and ETH share a config", () => {
    const graph = buildRouteGraph(config, ["btc-usd", "aeth-usd"]);
    const edges = [...graph.values()].flat();
    expect(edges).toHaveLength(10);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(10);
    const eth = edges.filter((edge) => edge.venue === "propamm" && edge.marketId === "aeth-usd");
    expect(eth).toHaveLength(2);
    expect(eth).toEqual(expect.arrayContaining([
      expect.objectContaining({ inputMint: market.baseMint, outputMint: market.quoteMint, allowClamm: true }),
      expect.objectContaining({ inputMint: market.quoteMint, outputMint: market.baseMint, allowClamm: true }),
    ]));
    expect(config.propammMarkets.map((entry) => entry.config)).toEqual([market.config, market.config]);
    expect(config.propammMarkets.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.sides))).toBe(true);
    expect(findRoutes(graph, market.baseMint, usd.shareMint)[0]!.steps.map((step) => step.operation)).toEqual(["propamm", "vaultMint"]);
    expect(supportedPairs(graph)).toHaveLength(20);
  });

  it("requires market opt-in and never creates a testnet ETH market", () => {
    for (const graph of [buildRouteGraph(config), buildRouteGraph(config, ["btc-usd"]),
      buildRouteGraph(NETWORKS.testnet, ["btc-usd", "aeth-usd"])]) {
      expect(graph.has(market.baseMint)).toBe(false);
    }
    const graph = buildRouteGraph(config, ["aeth-usd"]);
    expect([...graph.values()].flat().filter((edge) => edge.venue === "propamm")).toHaveLength(2);
  });

  it.each([config.mints.aBTC, config.mints.primeBTC])("discovers a single mixed CLAMM/RFQ path to %s", (output) => {
    const routes = findRoutes(buildRouteGraph(config, ["btc-usd", "aeth-usd"]), market.baseMint, output);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.steps.map(step => step.operation)).toEqual(output === config.mints.aBTC
      ? ["propamm", "clamm"] : ["propamm", "clamm", "vaultMint"]);
  });

  it("never revisits aETH", () => {
    expect(findRoutes(buildRouteGraph(config, ["btc-usd", "aeth-usd"]), market.baseMint, market.baseMint)).toEqual([]);
  });

  it.each([false, true])("automatically adds both aETH directions without duplicates, BTC RFQ enabled=%s", (btcEnabled) => {
    const state = setup();
    const { propAmmQuoteProvider: _btc, ...base } = state.options;
    const client = createRouterClient({ ...base, ...(btcEnabled && { propAmmQuoteProvider: state.propAmmQuoteProvider }) });
    const { directRfqQuoteProvider: _eth, ...withoutEth } = state.options;
    const legacy = createRouterClient(withoutEth);
    expect(client.supportedPairs).toHaveLength(20);
    expect(new Set(client.supportedPairs.map((pair) => `${pair.inputMint}:${pair.outputMint}`)).size).toBe(20);
    expect(client.supportedPairs).toEqual(expect.arrayContaining([...legacy.supportedPairs]));
    for (const outputMint of [usd.shareMint, config.mints.aBTC, config.mints.primeBTC]) {
      expect(client.supportedPairs).toContainEqual({ inputMint: market.baseMint, outputMint });
    }
    expect(client.supportedPairs.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(client.supportedPairs)).toBe(true);
    expect(client.mints).toBe(config.mints);
    expect(state.source.getAccounts).not.toHaveBeenCalled();
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });


});

describe("composable aETH quotes", () => {
  it.each([config.mints.aBTC, config.mints.primeBTC])("composes native sell, CLAMM and optional vault mint to %s within two reads", async (outputMint) => {
    const state = setup(outputMint);
    // Compare the suffix with the existing local quote API, including its fees.
    const local = await createRouterClient({ network: "mainnet", source: state.source }).quoteExactIn({
      ...state.request, inputMint: market.quoteMint, amountIn: state.rfq.estimatedAmountOut,
    });
    state.source.getAccounts.mockClear();
    const original = hex.encode(TransactionUtil.serialize(state.rfq.transaction));
    const quote = await state.client.quoteExactIn(state.request);

    expect(quote.estimatedAmountOut).toBe(local.estimatedAmountOut);
    expect(quote.minAmountOut).toBe(local.minAmountOut);
    expect(quote.deadlineMs).toBe(Number(state.rfq.expiresAtMs));
    expect(quote.rfq).toEqual({ quoteId: state.rfq.quoteId });
    expect(quote.hops.map(hop => hop.kind)).toEqual(outputMint === config.mints.aBTC
      ? ["propamm", "clamm"] : ["propamm", "clamm", "vaultMint"]);
    expect(quote.hops.slice(1)).toEqual(local.hops);
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({ ...state.request, outputMint: market.quoteMint });
    expect(state.propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expect(state.source.getAccounts).toHaveBeenCalledTimes(2);
    expect(state.source.getAccounts.mock.calls[0]![0]).toHaveLength(outputMint === config.mints.aBTC ? 3 : 6);
    expect(state.source.getAccounts.mock.calls[1]![0]).toHaveLength(3);
    const keys = state.source.getAccounts.mock.calls.flatMap(([keys]) => keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(hex.encode(TransactionUtil.serialize(state.rfq.transaction))).toBe(original);
    expect(quote.instructions[1]!.data.subarray(27, 60)).toEqual(state.rfq.transaction.message.instructions[0]!.data.subarray(1, 34));
    const message = compileRouterMessage(quote.instructions, state.request.user, new Uint8Array(32));
    expect(message.header).toMatchObject({ num_required_signatures: 2, num_readonly_signed_accounts: 1 });
    expect(message.account_keys.slice(0, 2).map(base58.encode)).toEqual([state.request.user, market.quoteSigner]);
    expect(message.account_keys.length).toBeLessThanOrEqual(50);
    const signedSize = TransactionUtil.serializedSize({ version: 0, message, signatures: [new Uint8Array(64), new Uint8Array(64)] });
    expect(signedSize).toBeLessThanOrEqual(4096);
  });

  it.each([config.mints.aBTC, config.mints.primeBTC])("rejects an RFQ that expires while loading ticks for %s", async (outputMint) => {
    const state = setup(outputMint);
    const read = state.source.getAccounts.getMockImplementation()!;
    state.source.getAccounts.mockImplementation(async keys => {
      if (state.source.getAccounts.mock.calls.length === 2) vi.mocked(Date.now).mockReturnValue(Number(state.rfq.expiresAtMs));
      return read(keys);
    });
    await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.source.getAccounts).toHaveBeenCalledTimes(2);
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
  });

  it.each([config.mints.aBTC, config.mints.primeBTC])("propagates a tick read failure for %s without a direct-sell fallback", async (outputMint) => {
    const state = setup(outputMint);
    const error = new Error("Ticks unavailable");
    const read = state.source.getAccounts.getMockImplementation()!;
    state.source.getAccounts.mockImplementationOnce(read).mockRejectedValueOnce(error);
    await expect(state.client.quoteExactIn(state.request)).rejects.toBe(error);
    expect(state.source.getAccounts).toHaveBeenCalledTimes(2);
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
  });

  it("propagates the BTC mint cap failure after both preceding hops", async () => {
    const state = setup(config.mints.primeBTC);
    setU64(state.accounts.get(config.venues.btcVault.address)!.data, 24, 1_000_000_000n);
    await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "DEPOSIT_CAP" });
    expect(state.source.getAccounts).toHaveBeenCalledTimes(2);
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
  });

  it.each([market.quoteMint, usd.shareMint])("preserves native sell terms and constructs the router bundle for %s", async (outputMint) => {
    const state = setup(outputMint);
    const original = hex.encode(TransactionUtil.serialize(state.rfq.transaction));
    const quote = await state.client.quoteExactIn(state.request);

    const minted = outputMint === usd.shareMint;
    const expectedOutput = state.rfq.estimatedAmountOut * (minted ? 990n : 1n);
    expect(quote).toMatchObject({ amountIn: 1_000_000n, estimatedAmountOut: expectedOutput,
      minAmountOut: expectedOutput * 9900n / 10_000n, deadlineMs: Number(state.rfq.expiresAtMs),
      rfq: { quoteId: state.rfq.quoteId } });
    expect(quote.hops.map((hop) => hop.kind)).toEqual(minted ? ["propamm", "vaultMint"] : ["propamm"]);
    expect(quote.hops[0]!.estimatedAmountOut).toBe(state.rfq.estimatedAmountOut);
    if (minted) expect(quote.hops[1]!.amountIn).toBe(state.rfq.estimatedAmountOut);
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({ ...state.request, outputMint: market.quoteMint });
    expect(state.propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expect(state.source.getAccounts).toHaveBeenCalledTimes(minted ? 1 : 0);
    if (minted) expect(state.source.getAccounts).toHaveBeenCalledExactlyOnceWith([usd.address, usd.assetMint, usd.shareMint, reserve]);
    expect(quote.instructions).toHaveLength(2);
    expect(quote.instructions[0]!.data).toEqual(Uint8Array.of(1));
    const router = quote.instructions[1]!;
    const native = state.rfq.transaction.message.instructions[0]!;
    expect(base58.encode(router.program_id)).toBe(config.programs.routerProgramId);
    expect(router.data[25]).toBe(minted ? 2 : 1);
    expect(router.data[26]).toBe(3);
    expect(router.data.subarray(27, 60)).toEqual(native.data.subarray(1, 34));
    const group = 2 + 2 * (quote.hops.length + 1);
    const nativeKey = (position: number) => base58.encode(state.rfq.transaction.message.account_keys[native.accounts[position]!]!);
    expect(router.accounts.slice(group, group + 7).map((account) => base58.encode(account.pubkey))).toEqual([
      market.programId, nativeKey(0), nativeKey(1), nativeKey(3), nativeKey(4), nativeKey(5), market.systemProgramId,
    ]);
    const message = compileRouterMessage(quote.instructions, state.request.user, new Uint8Array(32));
    expect(message.header).toMatchObject({ num_required_signatures: 2, num_readonly_signed_accounts: 1 });
    expect(message.account_keys.slice(0, 2).map(base58.encode)).toEqual([state.request.user, market.quoteSigner]);
    expect(message.account_keys.length).toBeLessThanOrEqual(50);
    expect(TransactionUtil.serializedSize({ version: 0, message, signatures: [new Uint8Array(64), new Uint8Array(64)] })).toBeLessThanOrEqual(4096);
    expect(hex.encode(TransactionUtil.serialize(state.rfq.transaction))).toBe(original);
    expect(state.rfq.transaction.signatures).toEqual([]);
  });

  it("resolves a legacy treasury buy using the same provider", async () => {
    const state = setup();
    const buy = fixtures.cases.find((fixture) => fixture.side === "buy")!;
    const transaction = nativeTransaction(buy.transaction_hex);
    state.directRfqQuoteProvider.quoteExactIn.mockResolvedValue({ ...state.rfq, transaction, estimatedAmountOut: BigInt(buy.estimated_amount_out) });
    const quote = await state.client.quoteExactIn({ ...state.request, inputMint: market.quoteMint, outputMint: market.baseMint });
    expect(quote.hops.map(hop => hop.kind)).toEqual(["treasuryMint"]);
    expect(quote).not.toHaveProperty("transaction");
    expect(state.source.getAccounts).not.toHaveBeenCalled();
    expect(state.propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });

  it("keeps BTC RFQs bound to their own provider when composable aETH sells are enabled", async () => {
    const state = setup();
    const request = { ...state.request, inputMint: config.mints.aBTC, amountIn: 1_000n };
    state.propAmmQuoteProvider.quoteExactIn.mockResolvedValue({
      quoteId: "btc-sell", quoteSigner: market.quoteSigner, estimatedAmountOut: 1_000_000n,
      terms: { side: "sell", baseAmount: request.amountIn, quoteAmount: 1_000_000n,
        expiryMs: state.rfq.expiresAtMs, nonce: 42n },
    });
    const quote = await state.client.quoteExactIn(request);
    expect(quote).toMatchObject({ inputMint: config.mints.aBTC, rfq: { quoteId: "btc-sell" } });
    expect(state.propAmmQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({
      inputMint: request.inputMint, outputMint: request.outputMint, amountIn: request.amountIn, user: request.user,
    });
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });

  it("preserves u64-scale native inputs without number conversion", async () => {
    const state = setup();
    const amountIn = (1n << 53n) + 1n;
    const data = state.rfq.transaction.message.instructions[0]!.data;
    for (const offset of [2, 34]) setU64(data, offset, amountIn);
    const quote = await state.client.quoteExactIn({ ...state.request, amountIn });

    expect(quote.amountIn).toBe(amountIn);
    expect(new DataView(quote.instructions[1]!.data.buffer).getBigUint64(28, true)).toBe(amountIn);
  });

  it("isolates the validated request from mutations by the RFQ provider", async () => {
    const state = setup();
    state.directRfqQuoteProvider.quoteExactIn.mockImplementation(async (request) => {
      Object.assign(request, { user: market.quoteSigner, amountIn: 1n, outputMint: market.baseMint });
      return state.rfq;
    });
    const quote = await state.client.quoteExactIn(state.request);
    expect(quote).toMatchObject({ amountIn: state.request.amountIn, inputMint: state.request.inputMint, outputMint: state.request.outputMint });
  });

  it.each(["signer", "base mint", "input", "minimum", "expiry", "extra instruction"])("rejects a tampered native sell: %s", async (field) => {
    const state = setup();
    const message = state.rfq.transaction.message;
    const trade = message.instructions[0]!;
    if (field === "signer") message.account_keys[1] = new Uint8Array(32).fill(99);
    if (field === "base mint") message.account_keys[trade.accounts[8]!] = new Uint8Array(32).fill(99);
    if (field === "input") setU64(trade.data, 34, state.request.amountIn + 1n);
    if (field === "minimum") setU64(trade.data, 42, 1n);
    if (field === "expiry") setU64(trade.data, 18, state.rfq.expiresAtMs + 1n);
    if (field === "extra instruction") message.instructions.push(trade);
    await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
    expect(state.source.getAccounts).not.toHaveBeenCalled();
  });

  it.each([market.quoteMint, usd.shareMint, config.mints.aBTC, config.mints.primeBTC])("rejects expired requests and receive sizing before I/O for %s", async (outputMint) => {
    const state = setup(outputMint);
    await expect(state.client.quoteExactIn({ ...state.request, deadlineMs: fixtures.now_ms }))
      .rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    await expect(state.client.quoteForOutput({ ...state.request, amountOut: 1n })).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    expect(state.source.getAccounts).not.toHaveBeenCalled();
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });

  it.each([[usd.shareMint, market.baseMint], [config.mints.aBTC, market.baseMint], [config.mints.primeBTC, market.baseMint]])("rejects aETH composition without its provider %s -> %s before I/O", async (inputMint, outputMint) => {
    const state = setup();
    const client = createRouterClient({ source: state.source, network: "mainnet" });
    await expect(client.quoteExactIn({ ...state.request, inputMint: inputMint!, outputMint: outputMint! }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    expect(state.source.getAccounts).not.toHaveBeenCalled();
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });

  it.each(["transport", "framing", "malformed"])("fails required USD vault %s without retrying or requesting an RFQ", async (failure) => {
    const state = setup(usd.shareMint);
    const error = new Error("Vault unavailable");
    if (failure === "transport") state.source.getAccounts.mockRejectedValueOnce(error);
    if (failure === "framing") state.source.getAccounts.mockResolvedValueOnce([]);
    if (failure === "malformed") state.accounts.get(usd.address)!.data = new Uint8Array();
    const result: unknown = await state.client.quoteExactIn(state.request).catch((error: unknown) => error);
    if (failure === "transport") expect(result).toBe(error);
    else expect(result).toMatchObject({ code: failure === "framing" ? "INVALID_RESPONSE" : "INVALID_ACCOUNT" });
    expect(state.source.getAccounts).toHaveBeenCalledOnce();
    expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  });

  it("propagates a sole vault suffix cap failure after quoting the native sell", async () => {
    const state = setup(usd.shareMint);
    setU64(state.accounts.get(usd.address)!.data, 24, 1_000_000_000n);
    await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "DEPOSIT_CAP" });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
    expect(state.source.getAccounts).toHaveBeenCalledOnce();
  });

  it("propagates provider rejection without falling back to the direct sell", async () => {
    const state = setup();
    const error = new Error("Maker declined");
    state.directRfqQuoteProvider.quoteExactIn.mockRejectedValueOnce(error);
    await expect(state.client.quoteExactIn(state.request)).rejects.toBe(error);
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
  });

  it.each(["bytes", "accounts"])("propagates the composed bundle's %s limit error without direct fallback", async (limit) => {
    const state = setup();
    const check = limits.assertMessageLimits;
    vi.spyOn(limits, "assertMessageLimits").mockImplementation((message, label) => check(
      label !== "PropAMM transaction" ? message : limit === "bytes" ? withPacketSize(message, 4097) : withAccountCount(message, 51), label,
    ));
    await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({
      code: limit === "bytes" ? "TRANSACTION_TOO_LARGE" : "TRANSACTION_TOO_MANY_ACCOUNTS",
    });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
    expect(state.source.getAccounts).not.toHaveBeenCalled();
  });

  it("rejects a native quote that expires while the provider is pending", async () => {
    const state = setup();
    state.directRfqQuoteProvider.quoteExactIn.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(Number(state.rfq.expiresAtMs));
      return state.rfq;
    });
    await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
  });

  it("clears the two-second timeout without retrying or direct fallback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = setup();
    state.directRfqQuoteProvider.quoteExactIn.mockImplementation(() => new Promise(() => {}));
    const pending = state.client.quoteExactIn(state.request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ code: "RFQ_TIMEOUT" });
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
