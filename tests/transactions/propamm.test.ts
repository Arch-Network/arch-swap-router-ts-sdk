import { TransactionUtil, type RuntimeTransaction } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeRouteExactInV1 } from "../../src/codecs/instruction.js";
import { NETWORKS, TESTNET } from "../../src/config/networks.js";
import { quotePropAmm } from "../../src/propamm.js";
import { buildPropAmmInstructions } from "../../src/transactions/instructions.js";
import type { BuildSwapInput, ResolvedStep } from "../../src/transactions/types.js";
import { compileRouterMessage, decodeAddress, deriveAddress, U64_MAX } from "../../src/utils.js";
import accounts from "../fixtures/propamm/accounts.json" with { type: "json" };
import trades from "../fixtures/propamm/trades.json" with { type: "json" };
import fixtures from "../fixtures/propamm/router-transactions.json" with { type: "json" };

/** Read the independently generated Rust wire fixtures, including their signatures. */
function nativeTransaction(raw: string): RuntimeTransaction {
  const data = hex.decode(raw), view = new DataView(data.buffer);
  let offset = 0;
  const take = (length: number) => { const result = data.slice(offset, offset + length); offset += length; return result; };
  const u8 = () => take(1)[0]!;
  const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value; };
  const version = u32(), signatures = Array.from({ length: u8() }, () => take(64));
  const header = { num_required_signatures: u8(), num_readonly_signed_accounts: u8(), num_readonly_unsigned_accounts: u8() };
  const account_keys = Array.from({ length: u32() }, () => take(32));
  const recent_blockhash = take(32);
  const instructions = Array.from({ length: u32() }, () => ({
    program_id_index: u8(), accounts: Array.from(take(u32())), data: take(u32()),
  }));
  expect(offset).toBe(data.length);
  return { version, signatures, message: { header, account_keys, recent_blockhash, instructions } };
}

function nativeInput(tx: RuntimeTransaction): BuildSwapInput {
  const instruction = tx.message.instructions[1]!;
  const key = (position: number) => base58.encode(tx.message.account_keys[instruction.accounts[position]!]!);
  const view = new DataView(instruction.data.buffer);
  const count = instruction.data[25]!;
  let offset = 26, group = 2 + 2 * (count + 1);
  const steps = Array.from({ length: count }, (_, i): ResolvedStep => {
    const outputMint = key(4 + 2 * i), tag = instruction.data[offset++]!;
    if (tag === 3) {
      const side = instruction.data[offset++] === 0 ? "buy" : "sell";
      const values = Array.from({ length: 4 }, () => { const value = view.getBigUint64(offset, true); offset += 8; return value; });
      const step: ResolvedStep = {
        kind: "propamm" as const, outputMint,
        terms: { side, baseAmount: values[0]!, quoteAmount: values[1]!, expiryMs: values[2]!, nonce: values[3]! },
        programId: key(group), config: key(group + 1), maker: key(group + 2),
        userNonce: key(group + 3), baseVault: key(group + 4), quoteVault: key(group + 5),
      };
      group += 7;
      return step;
    }
    const redeem = tag === 1;
    expect([0, 1]).toContain(tag);
    const common = {
      outputMint, vault: key(group + 1), reserve: key(group + 2),
      protocolFeeShares: key(group + (redeem ? 5 : 3)), managerFeeShares: key(group + (redeem ? 6 : 4)),
      eventAuthority: key(group + (redeem ? 7 : 5)),
    };
    const step: ResolvedStep = redeem
      ? { ...common, kind: "vaultRedeem", escrow: key(group + 3), redemptionEntry: key(group + 4) }
      : { ...common, kind: "vaultMint" };
    group += redeem ? 9 : 6;
    return step;
  });
  expect(offset).toBe(instruction.data.length);
  return {
    user: key(0), inputMint: key(2), amountIn: view.getBigUint64(1, true),
    minAmountOut: view.getBigUint64(9, true), deadlineMs: Number(view.getBigUint64(17, true)), steps,
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("native PropAMM contract", () => {
  it.each(fixtures)("matches Rust $side redeem=$redeem mint=$mint, bytes and signer privileges", (fixture) => {
    const tx = nativeTransaction(fixture.transaction_hex);
    const input = nativeInput(tx);
    const instructions = buildPropAmmInstructions(input, TESTNET);
    const message = compileRouterMessage(instructions, input.user, tx.message.recent_blockhash);
    expect(message).toEqual(tx.message);
    expect(hex.encode(TransactionUtil.serialize({ ...tx, message }))).toBe(fixture.transaction_hex);
    expect(message.header).toMatchObject({ num_required_signatures: 2, num_readonly_signed_accounts: 1 });
    expect(instructions).toHaveLength(2);
    expect(instructions[0]!.data).toEqual(Uint8Array.of(1));
    const propamm = input.steps.find((s) => s.kind === "propamm")!;
    expect(message.account_keys.slice(0, 2).map(base58.encode)).toEqual([input.user, propamm.maker]);
    const size = TransactionUtil.serializedSize({ ...tx, message });
    expect(size).toBe(fixture.transaction_hex.length / 2);
    expect(size).toBeLessThanOrEqual(1232);
    if (fixture.redeem && fixture.mint) expect(size).toBe(1225);
  });

  it("counts both signatures and rejects extra fee destinations that exceed the limit", () => {
    const fixture = fixtures.find((f) => f.redeem && f.mint)!;
    const input = nativeInput(nativeTransaction(fixture.transaction_hex));
    const steps = input.steps.map((s) => s.kind === "vaultMint"
      ? { ...s, managerFeeShares: base58.encode(new Uint8Array(32).fill(99)) } : s);
    expect(() => buildPropAmmInstructions({ ...input, steps }, TESTNET))
      .toThrow(expect.objectContaining({ code: "TRANSACTION_TOO_LARGE", message: expect.stringContaining("1257") }));
  });

  it("rejects a maker used as the user or a vault fee account", () => {
    const input = nativeInput(nativeTransaction(fixtures.find((f) => f.mint)!.transaction_hex));
    const maker = input.steps.find((s) => s.kind === "propamm")!.maker;
    expect(() => buildPropAmmInstructions({ ...input, user: maker }, TESTNET))
      .toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
    const steps = input.steps.map((s) => s.kind === "vaultMint" ? { ...s, managerFeeShares: maker } : s);
    expect(() => buildPropAmmInstructions({ ...input, steps }, TESTNET))
      .toThrow(expect.objectContaining({ code: "INVALID_RFQ" }));
  });

  it.each(trades.trades)("derives native PDAs and preserves the original $side CPI terms", async (trade) => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const native = accounts.deployments[0]!;
    const deployment = {
      programId: native.program_id, maker: accounts.maker, config: native.config.address,
      baseMint: accounts.base_mint, quoteMint: accounts.quote_mint,
    };
    const data = hex.decode(trade.data_hex), view = new DataView(data.buffer);
    const terms = {
      side: trade.side === "Buy" ? "buy" as const : "sell" as const,
      baseAmount: view.getBigUint64(2, true), quoteAmount: view.getBigUint64(10, true),
      expiryMs: view.getBigUint64(18, true), nonce: view.getBigUint64(26, true),
    };
    const buy = terms.side === "buy";
    const quote = await quotePropAmm({ quoteExactIn: async () => ({ quoteId: "native", terms, estimatedAmountOut: 99n }) }, {
      inputMint: buy ? accounts.quote_mint : accounts.base_mint,
      outputMint: buy ? accounts.base_mint : accounts.quote_mint,
      amountIn: buy ? terms.quoteAmount : terms.baseAmount, user: accounts.user, deadlineMs: Number(terms.expiryMs),
    }, deployment);
    expect(quote.resolved).toMatchObject({
      config: native.config.address, userNonce: native.user_nonce.address,
      baseVault: native.base_vault.address, quoteVault: native.quote_vault.address, terms,
    });
    expect(deriveAddress(native.program_id, "config", decodeAddress(accounts.maker))).toBe(native.config.address);
    const encoded = encodeRouteExactInV1({ amountIn: 1n, minAmountOut: 1n, deadlineMs: 0n, steps: [{ kind: "propamm", terms }] });
    expect(encoded.slice(26)).toEqual(Uint8Array.of(3, ...data.slice(1, 34)));
    expect(encoded).toHaveLength(60); // Native CPI's measured input/minimum are absent.
  });

  it("derives the configured testnet maker's config", () => {
    const deployment = NETWORKS.testnet.propamm;
    expect(deriveAddress(deployment.programId, "config", decodeAddress(deployment.maker))).toBe(deployment.config);
  });

  it("encodes u64 precision without rounding and disallows two RFQs", () => {
    const terms = { side: "sell" as const, baseAmount: 9007199254740993n, quoteAmount: U64_MAX, expiryMs: U64_MAX, nonce: U64_MAX };
    const args = { amountIn: terms.baseAmount, minAmountOut: 1n, deadlineMs: 1n, steps: [{ kind: "propamm" as const, terms }] };
    const encoded = encodeRouteExactInV1(args), view = new DataView(encoded.buffer);
    expect(view.getBigUint64(28, true)).toBe(9007199254740993n);
    for (const offset of [36, 44, 52]) expect(view.getBigUint64(offset, true)).toBe(U64_MAX);
    expect(() => encodeRouteExactInV1({ ...args, steps: [...args.steps, ...args.steps] }))
      .toThrow(expect.objectContaining({ code: "INVALID_INSTRUCTION" }));
    for (const invalid of [0n, -1n, U64_MAX + 1n, 1 as unknown as bigint]) {
      expect(() => encodeRouteExactInV1({ ...args, steps: [{ kind: "propamm", terms: { ...terms, baseAmount: invalid } }] }))
        .toThrow(expect.objectContaining({ code: "INVALID_INSTRUCTION" }));
    }
  });
});
