import { TransactionUtil } from "@arch-network/arch-sdk";
import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAINNET_AETH_USD as market } from "../src/config/aeth-usd.js";
import { normalizeAethUsdBuy } from "../src/direct-rfq.js";
import type { DirectRfqQuote, QuoteExactInRequest } from "../src/types.js";
import { decodeAddress, deriveAddress, U64_MAX } from "../src/utils.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };
import { nativeTransaction } from "./fixtures/aeth-usd/transactions.js";

const fixture = fixtures.cases.find(value => value.side === "buy")!;

function setup() {
  const request: QuoteExactInRequest = {
    inputMint: fixture.input_mint, outputMint: fixture.output_mint,
    amountIn: BigInt(fixture.amount_in), slippageBps: 100,
    user: fixtures.user, deadlineMs: fixtures.now_ms + 60_000,
  };
  const quote: DirectRfqQuote = {
    transaction: nativeTransaction(fixture.transaction_hex), quoteId: "buy-quote",
    expiresAtMs: BigInt(fixture.expires_at_ms), estimatedAmountOut: BigInt(fixture.estimated_amount_out),
  };
  return { request, quote, payment: quote.transaction.message.instructions[0]!, mint: quote.transaction.message.instructions[1]! };
}

type Setup = ReturnType<typeof setup>;
const writeU64 = (data: Uint8Array, offset: number, value: bigint) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset, value, true);

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

describe("aUSD → aETH treasury-buy normalization", () => {
  it("normalizes the native buy without changing the transaction, blockhash or message bytes", () => {
    const { request, quote } = setup();
    const result = normalizeAethUsdBuy(request, quote);
    expect(result).toEqual({
      execution: "serverTransaction", inputMint: market.quoteMint, outputMint: market.baseMint,
      amountIn: 1_000_000n, estimatedAmountOut: 400n, minAmountOut: 400n,
      deadlineMs: fixture.expires_at_ms,
      hops: [{ kind: "treasuryMint", inputMint: market.quoteMint, outputMint: market.baseMint,
        amountIn: 1_000_000n, estimatedAmountOut: 400n }],
      transaction: quote.transaction, rfq: { quoteId: "buy-quote" },
    });
    expect(result.transaction).toBe(quote.transaction);
    expect(hex.encode(TransactionUtil.serialize(result.transaction))).toBe(fixture.transaction_hex);
    expect(result).not.toHaveProperty("instructions");
  });

  it("clamps to an earlier request deadline without rewriting the server message", () => {
    const { request, quote } = setup();
    const deadlineMs = fixtures.now_ms + 10_000;
    const result = normalizeAethUsdBuy({ ...request, deadlineMs }, quote);
    expect(result.deadlineMs).toBe(deadlineMs);
    expect(quote.expiresAtMs).toBe(BigInt(fixture.expires_at_ms));
    expect(hex.encode(TransactionUtil.serialize(result.transaction))).toBe(fixture.transaction_hex);
  });

  it("clamps a u64 server expiry without converting it through an unsafe number", () => {
    const { request, quote } = setup();
    expect(normalizeAethUsdBuy(request, { ...quote, expiresAtMs: U64_MAX }).deadlineMs).toBe(request.deadlineMs);
  });

  it.each([0, 9999])("retains the exact minted payout with slippage %s bps", slippageBps => {
    const { request, quote } = setup();
    expect(normalizeAethUsdBuy({ ...request, slippageBps }, quote).minAmountOut).toBe(400n);
  });

  it("accepts a fresh mint ID only with its matching treasury-mint PDA", () => {
    const { request, quote, mint } = setup();
    mint.data.subarray(1, 33).fill(0x45);
    quote.transaction.message.account_keys[mint.accounts[3]!] = decodeAddress(
      deriveAddress(market.bridgeProgramId, "treasury_mint", mint.data.subarray(1, 33)),
    );
    const before = TransactionUtil.serialize(quote.transaction);
    const result = normalizeAethUsdBuy(request, quote);
    expect(TransactionUtil.serialize(result.transaction)).toEqual(before);
  });

  it.each([(1n << 53n) + 1n, U64_MAX])("preserves u64 input and payout precision for %s", amount => {
    const { request, quote, payment, mint } = setup();
    writeU64(payment.data, 1, amount);
    writeU64(mint.data, 33, amount);
    const result = normalizeAethUsdBuy({ ...request, amountIn: amount }, { ...quote, estimatedAmountOut: amount });
    expect(result.amountIn).toBe(amount);
    expect(result.estimatedAmountOut).toBe(amount);
    expect(result.minAmountOut).toBe(amount);
  });

  const invalidRequests: Partial<QuoteExactInRequest>[] = [
    { inputMint: market.baseMint }, { outputMint: market.quoteMint }, { user: "invalid" },
    { amountIn: 0n }, { amountIn: -1n }, { amountIn: U64_MAX + 1n }, { amountIn: 1 as unknown as bigint },
    { slippageBps: -1 }, { slippageBps: 10_000 }, { slippageBps: 0.5 }, { slippageBps: NaN },
    { deadlineMs: -1 }, { deadlineMs: Number.MAX_SAFE_INTEGER + 1 }, { deadlineMs: 1.5 },
  ];
  it.each(invalidRequests)("rejects invalid request %#", invalid => {
    const { request, quote } = setup();
    expect(() => normalizeAethUsdBuy({ ...request, ...invalid }, quote)).toThrow();
  });

  it.each(["request", "server"] as const)("rejects an expired %s deadline, including equality", source => {
    for (const offset of [-1, 0]) {
      const { request, quote } = setup();
      const expiry = fixtures.now_ms + offset;
      expect(() => normalizeAethUsdBuy(
        source === "request" ? { ...request, deadlineMs: expiry } : request,
        source === "server" ? { ...quote, expiresAtMs: BigInt(expiry) } : quote,
      )).toThrow(expect.objectContaining({ code: "RFQ_EXPIRED" }));
    }
  });

  const metadata: Partial<DirectRfqQuote>[] = [
    { quoteId: "" }, { quoteId: " " }, { expiresAtMs: 0n }, { expiresAtMs: U64_MAX + 1n },
    { expiresAtMs: fixture.expires_at_ms as unknown as bigint }, { estimatedAmountOut: 0n },
    { estimatedAmountOut: 399n }, { estimatedAmountOut: U64_MAX + 1n },
    { estimatedAmountOut: 400 as unknown as bigint },
  ];
  it.each(metadata)("rejects inconsistent RFQ metadata %#", invalid => {
    const { request, quote } = setup();
    expect(() => normalizeAethUsdBuy(request, { ...quote, ...invalid })).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
  });

  const tampering: [string, (value: Setup) => void][] = [
    ["version", s => { s.quote.transaction.version = 1; }],
    ["existing signature", s => { s.quote.transaction.signatures.push(new Uint8Array(64)); }],
    ["missing transaction", s => { Object.assign(s.quote, { transaction: null }); }],
    ["missing header", s => { Object.assign(s.quote.transaction.message, { header: null }); }],
    ["signer count", s => { s.quote.transaction.message.header.num_required_signatures = 1; }],
    ["readonly treasury", s => { s.quote.transaction.message.header.num_readonly_signed_accounts = 1; }],
    ["extra writable account", s => { s.quote.transaction.message.header.num_readonly_unsigned_accounts--; }],
    ["missing writable account", s => { s.quote.transaction.message.header.num_readonly_unsigned_accounts++; }],
    ["invalid readonly count", s => { s.quote.transaction.message.header.num_readonly_unsigned_accounts = -1; }],
    ["missing instructions", s => { s.quote.transaction.message.instructions = []; }],
    ["extra instruction", s => { s.quote.transaction.message.instructions.push(s.payment); }],
    ["invalid instruction", s => { Object.assign(s.quote.transaction.message.instructions, { 0: null }); }],
    ["short blockhash", s => { s.quote.transaction.message.recent_blockhash = new Uint8Array(31); }],
    ["short public key", s => { s.quote.transaction.message.account_keys[0] = new Uint8Array(31); }],
    ["wrong user", s => { s.quote.transaction.message.account_keys[0] = new Uint8Array(32).fill(0x77); }],
    ["wrong treasury", s => { s.quote.transaction.message.account_keys[1] = decodeAddress(market.quoteSigner); }],
    ["repeated public key", s => { s.quote.transaction.message.account_keys[2] = s.quote.transaction.message.account_keys[3]!; }],
    ["unused account", s => { s.quote.transaction.message.account_keys.push(new Uint8Array(32).fill(0x77)); s.quote.transaction.message.header.num_readonly_unsigned_accounts++; }],
    ["payment program", s => { s.payment.program_id_index = s.mint.program_id_index; }],
    ["mint program", s => { s.mint.program_id_index = s.payment.program_id_index; }],
    ["payment tag", s => { s.payment.data[0] = 4; }],
    ["mint tag", s => { s.mint.data[0] = 22; }],
    ["payment amount", s => { writeU64(s.payment.data, 1, 999_999n); }],
    ["zero payout", s => { writeU64(s.mint.data, 33, 0n); }],
    ["mint payout", s => { writeU64(s.mint.data, 33, 401n); }],
    ["recipient data", s => { s.mint.data[41] = s.mint.data[41]! ^ 1; }],
    ["mint ID without matching PDA", s => { s.mint.data[1] = s.mint.data[1]! ^ 1; }],
    ["payment data length", s => { s.payment.data = s.payment.data.slice(0, 8); }],
    ["mint data length", s => { s.mint.data = s.mint.data.slice(0, 72); }],
    ["payment account count", s => { s.payment.accounts.pop(); }],
    ["mint account count", s => { s.mint.accounts.push(0); }],
    ["non-byte instruction data", s => { Object.assign(s.payment, { data: Array.from(s.payment.data) }); }],
  ];
  it.each(tampering)("rejects tampered %s", (_, mutate) => {
    const state = setup();
    mutate(state);
    expect(() => normalizeAethUsdBuy(state.request, state.quote)).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
  });

  it.each([-1, 0.5, NaN, 256])("rejects invalid compiled account/program index %s", index => {
    for (const field of ["account", "program"]) {
      const state = setup();
      if (field === "account") state.payment.accounts[0] = index;
      else state.payment.program_id_index = index;
      expect(() => normalizeAethUsdBuy(state.request, state.quote)).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
    }
  });

  const roles = ["treasury", "bridge config", "asset", "mint PDA", "mint", "mint authority", "recipient", "destination ATA", "token program", "ATA program", "system program"];
  it.each(roles.map((role, index) => ({ role, index })))("rejects the wrong mint $role account", ({ index }) => {
    const { request, quote, mint } = setup();
    mint.accounts[index] = (mint.accounts[index]! + 1) % quote.transaction.message.account_keys.length;
    expect(() => normalizeAethUsdBuy(request, quote)).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
  });

  it.each([0, 1, 2])("rejects substituted payment account %s", index => {
    const { request, quote, payment } = setup();
    payment.accounts[index] = (payment.accounts[index]! + 1) % quote.transaction.message.account_keys.length;
    expect(() => normalizeAethUsdBuy(request, quote)).toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
  });

  it("counts both missing signatures when rejecting an oversized message", () => {
    const { request, quote } = setup();
    for (let i = 1; i <= 16; i++) quote.transaction.message.account_keys.push(new Uint8Array(32).fill(i));
    quote.transaction.message.header.num_readonly_unsigned_accounts += 16;
    expect(TransactionUtil.serializedSize(quote.transaction)).toBeLessThanOrEqual(1232);
    expect(() => normalizeAethUsdBuy(request, quote)).toThrow(expect.objectContaining({ code: "TRANSACTION_TOO_LARGE" }));
  });
});
