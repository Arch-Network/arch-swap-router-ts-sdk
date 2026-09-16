import { base58 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { TESTNET, TESTNET_MINTS } from "../../src/config/testnet.js";
import { buildRouterInstruction } from "../../src/transactions/instructions.js";
import { buildInput, expectedRouterInstruction, fixtures, namedFixture } from "./fixtures.js";

describe("router instruction", () => {
  it.each(fixtures)("matches Rust bytes, accounts, and privileges: $name", (fixture) => {
    expect(buildRouterInstruction(buildInput(fixture))).toEqual(expectedRouterInstruction(fixture));
  });

  it("preserves duplicate fee, event, and system positions", () => {
    const { accounts } = buildRouterInstruction(buildInput(namedFixture("three-hop-usd-shared")));
    expect(accounts).toHaveLength(35);
    expect(accounts[15]).toEqual(accounts[16]);
    expect(accounts[30]).toEqual(accounts[31]);
    expect(accounts[17]).toEqual(accounts[32]);
    expect(accounts[18]).toEqual(accounts[34]);
  });

  it("returns just the router instruction with the ATA/system trailer", () => {
    const instruction = buildRouterInstruction(buildInput(namedFixture("three-hop-btc-shared")));
    expect(Array.isArray(instruction)).toBe(false);
    expect(instruction.program_id).toEqual(base58.decode(TESTNET.routerProgramId));
    expect(instruction.accounts.slice(-2)).toEqual([
      { pubkey: base58.decode(TESTNET.associatedTokenProgramId), is_writable: false, is_signer: false },
      { pubkey: base58.decode(TESTNET.systemProgramId), is_writable: false, is_signer: false },
    ]);
  });

  it("encodes the resolved minimum and exact deadline without applying slippage again", () => {
    const input = buildInput(namedFixture("direct-mint-usd"));
    const { data } = buildRouterInstruction({ ...input, minAmountOut: 73n, deadlineMs: 1_800_000_000_987 });
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(1, true)).toBe(input.amountIn);
    expect(view.getBigUint64(9, true)).toBe(73n);
    expect(view.getBigUint64(17, true)).toBe(1_800_000_000_987n);
  });

  it("keeps an intermediate Mint output writable across a following swap", () => {
    const mint = buildInput(namedFixture("direct-mint-usd"));
    const swap = buildInput(namedFixture("direct-clamm-usd")).steps[0]!;
    // Native builder coverage beyond the fixed public pair registry.
    const { accounts } = buildRouterInstruction({ ...mint, steps: [mint.steps[0]!, swap] });
    expect(accounts[4]).toEqual({
      pubkey: base58.decode(TESTNET_MINTS.primeUSD), is_writable: true, is_signer: false,
    });
    expect(accounts[2]!.is_writable).toBe(false);
    expect(accounts[6]!.is_writable).toBe(false);
  });

  it("assembles synchronously without account or blockhash reads", () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected network request"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const instruction = buildRouterInstruction(buildInput(namedFixture("three-hop-btc-shared")));
      expect(instruction.data).toBeInstanceOf(Uint8Array);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects an unrepresentable deadline: %s", (deadlineMs) => {
      const input = buildInput(namedFixture("direct-mint-usd"));
      expect(() => buildRouterInstruction({ ...input, deadlineMs })).toThrow(
        expect.objectContaining({ code: "INVALID_INSTRUCTION" }),
      );
    },
  );
});
