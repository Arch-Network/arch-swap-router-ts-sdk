import { TransactionUtil } from "@arch-network/arch-sdk";
import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAINNET_AETH_USD as market } from "../src/config/aeth-usd.js";
import { normalizeAethUsdSell } from "../src/direct-rfq.js";
import { RouterSdkError } from "../src/errors.js";
import type { DirectRfqQuote, QuoteExactInRequest } from "../src/types.js";
import { decodeAddress, U64_MAX } from "../src/utils.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };
import { nativeTransaction } from "./fixtures/aeth-usd/transactions.js";

const fixture = fixtures.cases.find(value => value.side === "sell")!;

function setup() {
  const request: QuoteExactInRequest = {
    inputMint: fixture.input_mint, outputMint: fixture.output_mint,
    amountIn: BigInt(fixture.amount_in), slippageBps: 100,
    user: fixtures.user, deadlineMs: fixtures.now_ms + 60_000,
  };
  const quote: DirectRfqQuote = {
    transaction: nativeTransaction(fixture.transaction_hex), quoteId: "sell-quote",
    expiresAtMs: BigInt(fixture.expires_at_ms), estimatedAmountOut: BigInt(fixture.estimated_amount_out),
  };
  return { request, quote, trade: quote.transaction.message.instructions[0]! };
}

type Setup = ReturnType<typeof setup>;
const writeU64 = (data: Uint8Array, offset: number, value: bigint) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset, value, true);

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

describe("aETH → aUSD direct-sell normalization", () => {
  it("normalizes the native sell while preserving its exact original transaction", () => {
    const { request, quote } = setup();
    const result = normalizeAethUsdSell(request, quote);
    expect(result).toEqual({
      execution: "serverTransaction", inputMint: market.baseMint, outputMint: market.quoteMint,
      amountIn: 1_000n, estimatedAmountOut: 2_500_000n, minAmountOut: 2_475_000n,
      deadlineMs: fixture.expires_at_ms,
      hops: [{ kind: "propamm", inputMint: market.baseMint, outputMint: market.quoteMint,
        amountIn: 1_000n, estimatedAmountOut: 2_500_000n }],
      transaction: quote.transaction, rfq: { quoteId: "sell-quote" },
    });
    expect(result.transaction).toBe(quote.transaction);
    expect(hex.encode(TransactionUtil.serialize(result.transaction))).toBe(fixture.transaction_hex);
    expect(result).not.toHaveProperty("instructions");
  });

  it("returns a stronger signed minimum without applying slippage a second time", () => {
    const { request, quote } = setup();
    expect(normalizeAethUsdSell({ ...request, slippageBps: 200 }, quote).minAmountOut).toBe(2_475_000n);
  });

  it("uses the post-skew estimate when checking the user's minimum", () => {
    const { request, quote, trade } = setup();
    writeU64(trade.data, 42, 2_178_000n);
    const result = normalizeAethUsdSell(request, { ...quote, estimatedAmountOut: 2_200_000n });
    expect(result.estimatedAmountOut).toBe(2_200_000n);
    expect(result.minAmountOut).toBe(2_178_000n);
  });

  it("rounds a fractional slippage floor down using integer arithmetic", () => {
    const { request, quote, trade } = setup();
    writeU64(trade.data, 10, 101n);
    writeU64(trade.data, 42, 99n);
    expect(normalizeAethUsdSell(request, { ...quote, estimatedAmountOut: 101n }).minAmountOut).toBe(99n);
    writeU64(trade.data, 42, 98n);
    expect(() => normalizeAethUsdSell(request, { ...quote, estimatedAmountOut: 101n })).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
  });

  it("permits zero slippage only when the signed minimum covers the full estimate", () => {
    const { request, quote, trade } = setup();
    expect(() => normalizeAethUsdSell({ ...request, slippageBps: 0 }, quote)).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
    writeU64(trade.data, 42, quote.estimatedAmountOut);
    expect(normalizeAethUsdSell({ ...request, slippageBps: 0 }, quote).minAmountOut).toBe(quote.estimatedAmountOut);
  });

  it("clamps the client deadline without rewriting the instruction's expiry", () => {
    const { request, quote } = setup();
    const deadlineMs = fixtures.now_ms + 10_000;
    const result = normalizeAethUsdSell({ ...request, deadlineMs }, quote);
    expect(result.deadlineMs).toBe(deadlineMs);
    expect(hex.encode(TransactionUtil.serialize(result.transaction))).toBe(fixture.transaction_hex);
  });

  it("clamps a u64 encoded expiry without losing precision", () => {
    const { request, quote, trade } = setup();
    writeU64(trade.data, 18, U64_MAX);
    expect(normalizeAethUsdSell(request, { ...quote, expiresAtMs: U64_MAX }).deadlineMs).toBe(request.deadlineMs);
  });

  it.each([(1n << 53n) + 1n, U64_MAX])("preserves u64 input and payout precision for %s", amount => {
    const { request, quote, trade } = setup();
    for (const offset of [2, 10, 34, 42]) writeU64(trade.data, offset, amount);
    const result = normalizeAethUsdSell({ ...request, amountIn: amount }, { ...quote, estimatedAmountOut: amount });
    expect(result.amountIn).toBe(amount);
    expect(result.estimatedAmountOut).toBe(amount);
    expect(result.minAmountOut).toBe(amount);
  });

  it("reads an instruction backed by a nonzero byte offset", () => {
    const { request, quote, trade } = setup();
    const padded = new Uint8Array(58);
    padded.set(trade.data, 8);
    trade.data = padded.subarray(8);
    expect(normalizeAethUsdSell(request, quote).minAmountOut).toBe(2_475_000n);
    expect(hex.encode(TransactionUtil.serialize(quote.transaction))).toBe(fixture.transaction_hex);
  });

  it.each(["request", "server"] as const)("rejects an expired %s deadline, including equality", source => {
    for (const offset of [-1, 0]) {
      const { request, quote, trade } = setup();
      const expiry = fixtures.now_ms + offset;
      if (source === "server") writeU64(trade.data, 18, BigInt(expiry));
      expect(() => normalizeAethUsdSell(
        source === "request" ? { ...request, deadlineMs: expiry } : request,
        source === "server" ? { ...quote, expiresAtMs: BigInt(expiry) } : quote,
      )).toThrow(expect.objectContaining({ code: "RFQ_EXPIRED" }));
    }
  });

  const requests: Partial<QuoteExactInRequest>[] = [
    { inputMint: market.quoteMint }, { outputMint: market.baseMint }, { user: "invalid" },
    { amountIn: 0n }, { amountIn: U64_MAX + 1n }, { amountIn: 1000 as unknown as bigint },
    { slippageBps: -1 }, { slippageBps: 10_000 }, { slippageBps: 0.5 },
    { deadlineMs: -1 }, { deadlineMs: Number.MAX_SAFE_INTEGER + 1 },
  ];
  it.each(requests)("rejects invalid request %#", invalid => {
    const { request, quote } = setup();
    expect(() => normalizeAethUsdSell({ ...request, ...invalid }, quote)).toThrow(RouterSdkError);
  });

  const metadata: Partial<DirectRfqQuote>[] = [
    { quoteId: "" }, { quoteId: " " }, { expiresAtMs: 0n }, { expiresAtMs: U64_MAX + 1n },
    { expiresAtMs: BigInt(fixture.expires_at_ms) + 1n }, { expiresAtMs: fixture.expires_at_ms as unknown as bigint },
    { estimatedAmountOut: 0n }, { estimatedAmountOut: U64_MAX + 1n }, { estimatedAmountOut: 2_500_000 as unknown as bigint },
  ];
  it.each(metadata)("rejects inconsistent RFQ metadata %#", invalid => {
    const { request, quote } = setup();
    expect(() => normalizeAethUsdSell(request, { ...quote, ...invalid })).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
  });

  const tampering: [string, (value: Setup) => void][] = [
    ["version", s => { s.quote.transaction.version = 1; }],
    ["existing signature", s => { s.quote.transaction.signatures.push(new Uint8Array(64)); }],
    ["missing transaction", s => { Object.assign(s.quote, { transaction: null }); }],
    ["extra instruction", s => { s.quote.transaction.message.instructions.push(s.trade); }],
    ["extra signer", s => { s.quote.transaction.message.header.num_required_signatures = 3; }],
    ["readonly maker", s => { s.quote.transaction.message.header.num_readonly_signed_accounts = 1; }],
    ["extra writable account", s => { s.quote.transaction.message.header.num_readonly_unsigned_accounts--; }],
    ["missing writable account", s => { s.quote.transaction.message.header.num_readonly_unsigned_accounts++; }],
    ["wrong user", s => { s.quote.transaction.message.account_keys[0] = new Uint8Array(32).fill(0x77); }],
    ["wrong maker", s => { s.quote.transaction.message.account_keys[1] = decodeAddress(market.treasuryAuthority); }],
    ["repeated key", s => { s.quote.transaction.message.account_keys[2] = s.quote.transaction.message.account_keys[3]!; }],
    ["unused account", s => { s.quote.transaction.message.account_keys.push(new Uint8Array(32).fill(0x77)); s.quote.transaction.message.header.num_readonly_unsigned_accounts++; }],
    ["program", s => { s.trade.program_id_index = s.trade.accounts[10]!; }],
    ["tag", s => { s.trade.data[0] = 1; }],
    ["side", s => { s.trade.data[1] = 0; }],
    ["quoted input", s => { writeU64(s.trade.data, 2, 999n); }],
    ["actual input", s => { writeU64(s.trade.data, 34, 999n); }],
    ["zero nominal output", s => { writeU64(s.trade.data, 10, 0n); }],
    ["encoded expiry", s => { writeU64(s.trade.data, 18, BigInt(fixture.expires_at_ms) - 1n); }],
    ["minimum below floor", s => { writeU64(s.trade.data, 42, 2_474_999n); }],
    ["zero minimum", s => { writeU64(s.trade.data, 42, 0n); }],
    ["minimum above estimate", s => { writeU64(s.trade.data, 42, 2_500_001n); }],
    ["omitted minimum", s => { s.trade.data = s.trade.data.slice(0, 42); }],
    ["trailing data", s => { const data = new Uint8Array(51); data.set(s.trade.data); s.trade.data = data; }],
    ["omitted ATA program", s => { s.trade.accounts.pop(); }],
    ["extra account", s => { s.trade.accounts.push(0); }],
  ];
  it.each(tampering)("rejects tampered %s", (_, mutate) => {
    const state = setup();
    mutate(state);
    expect(() => normalizeAethUsdSell(state.request, state.quote)).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
  });

  const roles = ["config", "quote signer", "user", "nonce PDA", "base vault", "quote vault", "base ATA", "quote ATA", "base mint", "quote mint", "token program", "system program", "ATA program"];
  it.each(roles.map((role, index) => ({ role, index })))("rejects the wrong $role account", ({ index }) => {
    const { request, quote, trade } = setup();
    trade.accounts[index] = (trade.accounts[index]! + 1) % quote.transaction.message.account_keys.length;
    expect(() => normalizeAethUsdSell(request, quote)).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
  });

  it.each([-1, 0.5, NaN, 256])("rejects invalid compiled account/program index %s", index => {
    for (const field of ["account", "program"]) {
      const state = setup();
      if (field === "account") state.trade.accounts[0] = index;
      else state.trade.program_id_index = index;
      expect(() => normalizeAethUsdSell(state.request, state.quote)).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
    }
  });

  it("includes both signatures in the packet limit", () => {
    const { request, quote } = setup();
    for (let i = 1; i <= 17; i++) quote.transaction.message.account_keys.push(new Uint8Array(32).fill(i));
    quote.transaction.message.header.num_readonly_unsigned_accounts += 17;
    expect(TransactionUtil.serializedSize(quote.transaction)).toBeLessThanOrEqual(1232);
    expect(() => normalizeAethUsdSell(request, quote)).toThrow(expect.objectContaining({ code: "TRANSACTION_TOO_LARGE" }));
  });
});
