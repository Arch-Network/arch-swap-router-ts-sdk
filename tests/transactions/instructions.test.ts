import { base58 } from "@scure/base";
import { PubkeyUtil } from "@arch-network/arch-sdk";
import { describe, expect, it, vi } from "vitest";
import { TESTNET, TESTNET_MINTS } from "../../src/config/networks.js";
import { buildRouterInstruction } from "../../src/transactions/instructions.js";
import { buildInput, expectedRouterInstruction, fixtures, namedFixture } from "./fixtures.js";

describe("router instruction", () => {
  it("uses selected programs for CPI accounts, user ATAs and the trailer", () => {
    const key = (byte: number) => base58.encode(new Uint8Array(32).fill(byte));
    const programs = {
      routerProgramId: key(61), vaultProgramId: key(62), clammProgramId: key(63),
      tokenProgramId: key(64), associatedTokenProgramId: key(65), systemProgramId: key(66),
    };
    const fixture = namedFixture("three-hop-btc-shared");
    const instruction = buildRouterInstruction(buildInput(fixture), programs);
    const expected = expectedRouterInstruction(fixture);
    const replacement = new Map(Object.entries(TESTNET).map(([name, address]) => [address as string, programs[name as keyof typeof programs]]));
    expected.program_id = base58.decode(programs.routerProgramId);
    expected.accounts = expected.accounts.map((meta) => ({
      ...meta, pubkey: base58.decode(replacement.get(base58.encode(meta.pubkey)) ?? base58.encode(meta.pubkey)),
    }));
    fixture.mints.forEach((mint, i) => {
      expected.accounts[3 + i * 2]!.pubkey = PubkeyUtil.getAssociatedTokenAddress(
        base58.decode(mint), base58.decode(fixture.user), true,
        base58.decode(programs.tokenProgramId), base58.decode(programs.associatedTokenProgramId),
      );
    });
    expect(instruction).toEqual(expected);
  });

  it.each(fixtures)("matches Rust bytes, accounts, and privileges: $name", (fixture) => {
    expect(buildRouterInstruction(buildInput(fixture), TESTNET)).toEqual(expectedRouterInstruction(fixture));
  });

  it("preserves duplicate fee, event, and system positions", () => {
    const { accounts } = buildRouterInstruction(buildInput(namedFixture("three-hop-usd-shared")), TESTNET);
    expect(accounts).toHaveLength(35);
    expect(accounts[15]).toEqual(accounts[16]);
    expect(accounts[30]).toEqual(accounts[31]);
    expect(accounts[17]).toEqual(accounts[32]);
    expect(accounts[18]).toEqual(accounts[34]);
  });

  it("returns just the router instruction with the ATA/system trailer", () => {
    const instruction = buildRouterInstruction(buildInput(namedFixture("three-hop-btc-shared")), TESTNET);
    expect(Array.isArray(instruction)).toBe(false);
    expect(instruction.program_id).toEqual(base58.decode(TESTNET.routerProgramId));
    expect(instruction.accounts.slice(-2)).toEqual([
      { pubkey: base58.decode(TESTNET.associatedTokenProgramId), is_writable: false, is_signer: false },
      { pubkey: base58.decode(TESTNET.systemProgramId), is_writable: false, is_signer: false },
    ]);
  });

  it("encodes the resolved minimum and exact deadline without applying slippage again", () => {
    const input = buildInput(namedFixture("direct-mint-usd"));
    const { data } = buildRouterInstruction({ ...input, minAmountOut: 73n, deadlineMs: 1_800_000_000_987 }, TESTNET);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(1, true)).toBe(input.amountIn);
    expect(view.getBigUint64(9, true)).toBe(73n);
    expect(view.getBigUint64(17, true)).toBe(1_800_000_000_987n);
  });

  it("keeps an intermediate Mint output writable across a following swap", () => {
    const mint = buildInput(namedFixture("direct-mint-usd"));
    const swap = buildInput(namedFixture("direct-clamm-usd")).steps[0]!;
    // Native builder coverage beyond the fixed public pair registry.
    const { accounts } = buildRouterInstruction({ ...mint, steps: [mint.steps[0]!, swap] }, TESTNET);
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
      const instruction = buildRouterInstruction(buildInput(namedFixture("three-hop-btc-shared")), TESTNET);
      expect(instruction.data).toBeInstanceOf(Uint8Array);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects an unrepresentable deadline: %s", (deadlineMs) => {
      const input = buildInput(namedFixture("direct-mint-usd"));
      expect(() => buildRouterInstruction({ ...input, deadlineMs }, TESTNET)).toThrow(
        expect.objectContaining({ code: "INVALID_INSTRUCTION" }),
      );
    },
  );
});
