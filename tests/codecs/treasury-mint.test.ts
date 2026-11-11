import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { encodeRouteExactInV1 } from "../../src/codecs/instruction.js";
import type { RouteExactInV1Args, StepArgs } from "../../src/codecs/types.js";

const mint = { kind: "treasuryMint" as const, terms: { issuanceId: new Uint8Array(32).fill(0x44),
  quotedInput: 100n, quotedOutput: 50n, minInput: 99n, maxInput: 101n, expiryMs: 2000n } };
const args: RouteExactInV1Args = { amountIn: 100n, minAmountOut: 49n, deadlineMs: 1000n, steps: [mint] };
const clamm: StepArgs = { kind: "clamm", aToB: true, sqrtPriceLimit: 0n, supplementalTickArrayCount: 0 };
const native: StepArgs = { kind: "propamm", terms: { side: "buy", baseAmount: 50n, quoteAmount: 100n, expiryMs: 2000n, nonce: 1n } };

function invalid(input: unknown) {
  expect(() => encodeRouteExactInV1(input as RouteExactInV1Args)).toThrow(expect.objectContaining({ code: "INVALID_INSTRUCTION" }));
}

describe("treasury router wire contract", () => {
  it("appends tag 4 and exactly 72 payload bytes in the agreed order", () => {
    const expected = "0064000000000000003100000000000000e80300000000000001"
      + "04" + "44".repeat(32)
      + "6400000000000000320000000000000063000000000000006500000000000000d007000000000000";
    expect(hex.encode(encodeRouteExactInV1(args))).toBe(expected);
    expect(encodeRouteExactInV1(args)).toHaveLength(26 + 73);
  });

  it.each([
    [mint], [{ kind: "vaultRedeem" }, mint], [clamm, mint], [{ kind: "vaultRedeem" }, clamm, mint],
    [mint, { kind: "vaultMint" }], [mint, clamm], [mint, clamm, { kind: "vaultMint" }],
  ])("encodes a supported treasury shape %#", (...steps) => {
    expect(encodeRouteExactInV1({ ...args, steps: steps as StepArgs[] })[25]).toBe(steps.length);
  });

  it.each([
    [mint, { kind: "vaultRedeem" }], [mint, clamm, clamm], [mint, mint], [native, mint], [mint, native],
    [{ kind: "vaultMint" }, mint], [clamm, clamm, mint], [clamm, { kind: "vaultRedeem" }, mint],
  ])("rejects unsupported shapes and multiple quoted steps %#", (...steps) => invalid({ ...args, steps }));

  it.each(["quotedInput", "quotedOutput", "minInput", "maxInput", "expiryMs"] as const)("rejects invalid %s without truncation", field => {
    for (const value of [0n, -1n, 1n << 64n, 1, "1", undefined]) {
      invalid({ ...args, steps: [{ ...mint, terms: { ...mint.terms, [field]: value } }] });
    }
  });

  it("requires a 32-byte issuance ID", () => {
    for (const issuanceId of [undefined, new Uint8Array(31), new Uint8Array(33), new Array(32).fill(0)]) {
      invalid({ ...args, steps: [{ ...mint, terms: { ...mint.terms, issuanceId } }] });
    }
  });

  it("rejects bounds excluding nominal input and a deadline after expiry", () => {
    invalid({ ...args, steps: [{ ...mint, terms: { ...mint.terms, minInput: 101n } }] });
    invalid({ ...args, steps: [{ ...mint, terms: { ...mint.terms, maxInput: 99n } }] });
    invalid({ ...args, deadlineMs: 2001n });
    expect(encodeRouteExactInV1({ ...args, deadlineMs: 2000n })).toHaveLength(99);
  });
});
