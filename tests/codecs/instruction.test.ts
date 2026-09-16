import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { encodeRouteExactInV1 } from "../../src/codecs/instruction.js";
import type { RouteExactInV1Args, StepArgs } from "../../src/codecs/types.js";
import { RouterSdkError } from "../../src/errors/index.js";
import fixtures from "../fixtures/router-codec/v1.json" with { type: "json" };

const validArgs: RouteExactInV1Args = {
  amountIn: 100n,
  minAmountOut: 90n,
  deadlineMs: 1_000n,
  steps: [{ kind: "vaultMint" }],
};

const clamm: Extract<StepArgs, { kind: "clamm" }> = {
  kind: "clamm",
  aToB: true,
  sqrtPriceLimit: 123n,
  supplementalTickArrayCount: 0,
};

// JSON stores full-width integers as decimal strings, never JS numbers.
function fixtureStep(step: (typeof fixtures.instructions)[number]["steps"][number]): StepArgs {
  switch (step.kind) {
    case "vaultMint":
    case "vaultRedeem":
      return { kind: step.kind };
    case "clamm":
      if (
        step.aToB === undefined ||
        step.sqrtPriceLimit === undefined ||
        step.supplementalTickArrayCount === undefined
      ) throw new Error("Incomplete CLAMM fixture.");
      return {
        kind: "clamm",
        aToB: step.aToB,
        sqrtPriceLimit: BigInt(step.sqrtPriceLimit),
        supplementalTickArrayCount: step.supplementalTickArrayCount,
      };
    default:
      throw new Error(`Unknown fixture step: ${step.kind}`);
  }
}

function expectInvalid(args: unknown): void {
  const encode = () => encodeRouteExactInV1(args as RouteExactInV1Args);
  expect(encode).toThrow(RouterSdkError);
  expect(encode).toThrow(
    expect.objectContaining({ code: "INVALID_INSTRUCTION" }),
  );
}

describe("RouteExactInV1 encoding", () => {
  it.each(fixtures.instructions)("matches the Rust fixture: $name", (fixture) => {
    const args: RouteExactInV1Args = {
      amountIn: BigInt(fixture.amountIn),
      minAmountOut: BigInt(fixture.minAmountOut),
      deadlineMs: BigInt(fixture.deadlineMs),
      steps: fixture.steps.map(fixtureStep),
    };
    expect(encodeRouteExactInV1(args)).toEqual(hex.decode(fixture.hex));
  });

  it.each(["amountIn", "minAmountOut"] as const)("rejects invalid %s without truncation", (field) => {
    for (const value of [0n, -1n, 1n << 64n, 1, "1", undefined]) {
      expectInvalid({ ...validArgs, [field]: value });
    }
  });

  it("rejects negative, overflowing, or non-bigint deadlines", () => {
    for (const deadlineMs of [-1n, 1n << 64n, 1_800_000_000_123, "1000", undefined]) {
      expectInvalid({ ...validArgs, deadlineMs });
    }
  });

  it.each([0, 4, 255])("rejects %i steps", (length) => {
    expectInvalid({ ...validArgs, steps: Array.from({ length }, () => ({ kind: "vaultMint" })) });
  });

  it("rejects unsupported or missing step kinds, including reserved PropAMM", () => {
    for (const step of [{ kind: "propamm" }, { kind: "other" }, {}, undefined]) {
      expectInvalid({ ...validArgs, steps: [step] });
    }
    expectInvalid({ ...validArgs, steps: new Array<StepArgs>(1) });
  });

  it("rejects non-boolean CLAMM directions rather than coercing them", () => {
    for (const aToB of [0, 1, 2, "false", undefined]) {
      expectInvalid({ ...validArgs, steps: [{ ...clamm, aToB }] });
    }
  });

  it("rejects invalid u128 prices without truncation", () => {
    for (const sqrtPriceLimit of [-1n, 1n << 128n, 1, "1", undefined]) {
      expectInvalid({ ...validArgs, steps: [{ ...clamm, sqrtPriceLimit }] });
    }
  });

  it("rejects supplemental counts outside the Rust 0..3 integer range", () => {
    for (const supplementalTickArrayCount of [-1, 4, 256, 1.5, NaN, Infinity, "0", undefined]) {
      expectInvalid({
        ...validArgs,
        steps: [{ ...clamm, supplementalTickArrayCount }],
      });
    }
  });
});
