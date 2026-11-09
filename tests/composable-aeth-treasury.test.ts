import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET_AETH_USD as market } from "../src/index.js";
import { NETWORKS } from "../src/config/networks.js";
import { compileRouterMessage, decodeAddress, deriveAddress, U64_MAX } from "../src/utils.js";
import * as limits from "../src/transactions/size.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };
import { setupComposableAethTreasuryBuy as setup, setU64, treasuryAethBuyQuote } from "./fixtures/composable-aeth.js";
import { withAccountCount, withPacketSize } from "./helpers/transaction-limits.js";

const config = NETWORKS.mainnet;
const cases = [
  { input: config.mints.aUSD, kinds: ["treasuryMint"], reads: 0, initial: 0, offset: 26, prefixAccounts: 0 },
  { input: config.mints.primeUSD, kinds: ["vaultRedeem", "treasuryMint"], reads: 1, initial: 4, offset: 27, prefixAccounts: 9 },
  { input: config.mints.aBTC, kinds: ["clamm", "treasuryMint"], reads: 2, initial: 3, offset: 45, prefixAccounts: 8 },
  { input: config.mints.primeBTC, kinds: ["vaultRedeem", "clamm", "treasuryMint"], reads: 2, initial: 6, offset: 46, prefixAccounts: 17 },
] as const;

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each([false, true])("aETH treasury routing, bounded authorization=%s", bounded => {
  it.each(cases)("prepares $input with one quote and $reads account reads", async ({ input, kinds, reads, initial, offset, prefixAccounts }) => {
    const state = setup(input, bounded);
    const prefix = input === market.quoteMint ? undefined
      : await createRouterClient({ network: "mainnet", source: state.source }).quoteExactIn({ ...state.request, outputMint: market.quoteMint });
    state.source.getAccounts.mockClear();
    const quote = await state.client.quoteExactIn(state.request);
    const amountIn = prefix?.estimatedAmountOut ?? state.request.amountIn;
    expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({ ...state.request, inputMint: market.quoteMint, amountIn });
    expect(state.propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    expect(state.source.getAccounts).toHaveBeenCalledTimes(reads);
    if (reads) expect(state.source.getAccounts.mock.calls[0]![0]).toHaveLength(initial);
    const keys = state.source.getAccounts.mock.calls.flatMap(([keys]) => keys);
    expect(new Set(keys).size).toBe(keys.length);
    const rfq = await state.directRfqQuoteProvider.quoteExactIn.mock.results[0]!.value;
    expect(hex.encode(TransactionUtil.serialize(rfq.transaction)))
      .toBe(hex.encode(TransactionUtil.serialize(treasuryAethBuyQuote(amountIn, bounded).transaction)));
    expect(quote.hops.map(hop => hop.kind)).toEqual(kinds);
    if (prefix) expect(quote.hops.slice(0, -1)).toEqual(prefix.hops);
    expect(quote).toMatchObject({ estimatedAmountOut: rfq.estimatedAmountOut,
      minAmountOut: rfq.estimatedAmountOut * 9900n / 10_000n, deadlineMs: Number(rfq.expiresAtMs / 1000n * 1000n),
      rfq: { quoteId: rfq.quoteId } });
    const [ata, router] = quote.instructions;
    expect(quote.instructions).toHaveLength(2);
    expect(ata!.data).toEqual(Uint8Array.of(1));
    const step = router!.data.subarray(offset);
    expect(step).toHaveLength(73);
    expect(step[0]).toBe(4);
    expect(step.subarray(1, 33)).toEqual(rfq.transaction.message.instructions[1]!.data.subarray(1, 33));
    const view = new DataView(step.buffer, step.byteOffset, step.byteLength);
    expect([33, 41, 49, 57, 65].map(offset => view.getBigUint64(offset, true))).toEqual([
      amountIn, rfq.estimatedAmountOut, rfq.treasuryAuthorization!.minAmountIn,
      rfq.treasuryAuthorization!.maxAmountIn, rfq.expiresAtMs,
    ]);
    const group = 2 + 2 * (kinds.length + 1) + prefixAccounts;
    const issuance = step.subarray(1, 33);
    const venue = router!.accounts.slice(group, group + 10);
    expect(venue.map(account => base58.encode(account.pubkey))).toEqual([
      market.bridgeProgramId, market.treasuryAuthority, deriveAddress(market.bridgeProgramId, "config"),
      deriveAddress(market.bridgeProgramId, "asset", decodeAddress(market.baseMint)),
      deriveAddress(market.bridgeProgramId, "treasury_mint", issuance),
      deriveAddress(market.bridgeProgramId, "mint-authority", decodeAddress(market.baseMint)),
      market.config, market.quoteVault, market.associatedTokenProgramId, market.systemProgramId,
    ]);
    expect(venue.map(account => [account.is_writable, account.is_signer])).toEqual([
      [false, false], [true, true], [false, false], [false, false], [true, false],
      [false, false], [false, false], [true, false], [false, false], [false, false],
    ]);
    expect(router!.accounts[2 + 2 * kinds.length]!.is_writable).toBe(true);
    const message = compileRouterMessage(quote.instructions, state.request.user, new Uint8Array(32));
    expect(message.header).toMatchObject({ num_required_signatures: 2, num_readonly_signed_accounts: 0 });
    expect(message.account_keys.slice(0, 2).map(base58.encode)).toEqual([state.request.user, market.treasuryAuthority]);
    expect(message.account_keys).toHaveLength(new Set(message.account_keys.map(base58.encode)).size);
    expect(message.account_keys.length).toBeLessThanOrEqual(50);
    expect(TransactionUtil.serializedSize({ version: 0, message, signatures: [new Uint8Array(64), new Uint8Array(64)] })).toBeLessThanOrEqual(4096);
  });
});

it.each(cases)("rejects missing treasury authorization from $input without inventing bounds or retrying", async ({ input }) => {
  const state = setup(input);
  const issue = state.directRfqQuoteProvider.quoteExactIn.getMockImplementation()!;
  state.directRfqQuoteProvider.quoteExactIn.mockImplementation(async request => {
    const { treasuryAuthorization: _authorization, ...quote } = await issue(request);
    return quote;
  });
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({
    code: "INVALID_RFQ", message: "Treasury routing requires server-issued authorization.",
  });
  expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
  expect(state.propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
});

it.each(cases)("rejects expired requests and receive sizing before I/O from $input", async ({ input }) => {
  const state = setup(input);
  await expect(state.client.quoteExactIn({ ...state.request, deadlineMs: fixtures.now_ms })).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
  await expect(state.client.quoteForOutput({ ...state.request, amountOut: 1n })).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
  expect(state.source.getAccounts).not.toHaveBeenCalled();
  expect(state.directRfqQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
});

it.each(["version", "null", "zero minimum", "minimum above nominal", "maximum below nominal", "overflow", "number", "zero payout", "payout overflow"])("rejects invalid treasury authorization: %s", async field => {
  const state = setup(market.quoteMint, true);
  const authorization = { ...state.rfq.treasuryAuthorization! };
  if (field === "version") Object.assign(authorization, { version: 2 });
  if (field === "zero minimum") authorization.minAmountIn = 0n;
  if (field === "minimum above nominal") authorization.minAmountIn = state.request.amountIn + 1n;
  if (field === "maximum below nominal") authorization.maxAmountIn = state.request.amountIn - 1n;
  if (field === "overflow") authorization.maxAmountIn = U64_MAX + 1n;
  if (field === "number") Object.assign(authorization, { minAmountIn: 1 });
  if (field === "zero payout") authorization.minAmountIn = 1n;
  if (field === "payout overflow") {
    setU64(state.rfq.transaction.message.instructions[1]!.data, 33, U64_MAX);
    Object.assign(state.rfq, { estimatedAmountOut: U64_MAX });
  }
  state.directRfqQuoteProvider.quoteExactIn.mockResolvedValue({ ...state.rfq,
    treasuryAuthorization: field === "null" ? null as never : authorization });
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
  expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
  expect(state.source.getAccounts).not.toHaveBeenCalled();
});

it("uses the conservative whole-second expiry and preserves the issued expiry bytes", async () => {
  const state = setup();
  const expiresAtMs = BigInt(fixtures.now_ms + 1999);
  state.directRfqQuoteProvider.quoteExactIn.mockResolvedValue({ ...state.rfq, expiresAtMs });
  const quote = await state.client.quoteExactIn(state.request);
  expect(quote.deadlineMs).toBe(fixtures.now_ms + 1000);
  expect(new DataView(quote.instructions[1]!.data.buffer).getBigUint64(91, true)).toBe(expiresAtMs);
  vi.mocked(Date.now).mockReturnValue(fixtures.now_ms + 1000);
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "RFQ_EXPIRED" });
});

it("clamps to an earlier caller deadline", async () => {
  const state = setup();
  const deadlineMs = fixtures.now_ms + 1;
  expect((await state.client.quoteExactIn({ ...state.request, deadlineMs })).deadlineMs).toBe(deadlineMs);
});

it("preserves full-u64 amounts with explicitly issued fixed bounds without Number conversion", async () => {
  const state = setup(market.quoteMint, false);
  const quote = await state.client.quoteExactIn({ ...state.request, amountIn: U64_MAX });
  const view = new DataView(quote.instructions[1]!.data.buffer);
  expect([59, 75, 83].map(offset => view.getBigUint64(offset, true))).toEqual([U64_MAX, U64_MAX, U64_MAX]);
  expect(quote.estimatedAmountOut).toBe(U64_MAX * 2n / 5n);
});

it.each(["payment", "output", "recipient", "bridge", "receipt", "authority", "privileges", "signed"])("validates the original treasury template: %s", async field => {
  const state = setup();
  const message = state.rfq.transaction.message;
  const [payment, mint] = message.instructions;
  if (field === "payment") setU64(payment!.data, 1, state.request.amountIn + 1n);
  if (field === "output") setU64(mint!.data, 33, state.rfq.estimatedAmountOut + 1n);
  if (field === "recipient") mint!.data[41] ^= 1;
  if (field === "bridge") message.account_keys[mint!.program_id_index] = new Uint8Array(32).fill(99);
  if (field === "receipt") message.account_keys[mint!.accounts[3]!] = new Uint8Array(32).fill(99);
  if (field === "authority") message.account_keys[1] = new Uint8Array(32).fill(99);
  if (field === "privileges") message.header.num_readonly_signed_accounts = 1;
  if (field === "signed") state.rfq.transaction.signatures.push(new Uint8Array(64));
  state.directRfqQuoteProvider.quoteExactIn.mockResolvedValue(state.rfq);
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
  expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
});

it.each(["bytes", "accounts"])("checks the complete treasury bundle's %s limit", async limit => {
  const state = setup();
  const check = limits.assertMessageLimits;
  vi.spyOn(limits, "assertMessageLimits").mockImplementation((message, label) => check(
    label !== "Treasury mint transaction" ? message : limit === "bytes" ? withPacketSize(message, 4097) : withAccountCount(message, 51), label));
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({
    code: limit === "bytes" ? "TRANSACTION_TOO_LARGE" : "TRANSACTION_TOO_MANY_ACCOUNTS",
  });
  expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
});

it("rejects treasury authorization attached to a native provider packet", async () => {
  const { setupComposableAethBuy } = await import("./fixtures/composable-aeth.js");
  const state = setupComposableAethBuy();
  state.directRfqQuoteProvider.quoteExactIn.mockResolvedValue({ ...state.rfq,
    treasuryAuthorization: { version: 1, minAmountIn: state.request.amountIn, maxAmountIn: state.request.amountIn } });
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
});

it("times out a treasury provider without another quote attempt", async () => {
  vi.useFakeTimers();
  const state = setup();
  state.directRfqQuoteProvider.quoteExactIn.mockImplementation(() => new Promise(() => {}));
  const pending = expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "RFQ_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(2000);
  await pending;
  expect(state.directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledOnce();
});
