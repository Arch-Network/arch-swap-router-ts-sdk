import { SystemInstruction } from "@arch-network/arch-sdk";
import { RouterSdkError } from "../errors/index.js";
import type { RouteExactInV1Args, StepArgs } from "./types.js";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const ROUTE_HEADER_LEN = 26;

function assertIntegerRange(
  value: bigint,
  field: string,
  min: bigint,
  max: bigint,
): void {
  // SDK integer writers truncate out-of-range values; reject before writing.
  if (typeof value !== "bigint" || value < min || value > max) {
    throw new RouterSdkError(
      "INVALID_INSTRUCTION",
      `${field} must be a bigint in the range ${min}..${max}.`,
    );
  }
}

function encodeStep(step: StepArgs): Uint8Array {
  switch (step?.kind) {
    case "vaultMint":
      return Uint8Array.of(0);
    case "vaultRedeem":
      return Uint8Array.of(1);
    case "clamm": {
      if (typeof step.aToB !== "boolean") {
        throw new RouterSdkError("INVALID_INSTRUCTION", "CLAMM aToB must be a boolean.");
      }
      assertIntegerRange(step.sqrtPriceLimit, "CLAMM sqrtPriceLimit", 0n, U128_MAX);
      const count = step.supplementalTickArrayCount;
      if (!Number.isInteger(count) || count < 0 || count > 3) {
        throw new RouterSdkError(
          "INVALID_INSTRUCTION",
          "CLAMM supplementalTickArrayCount must be an integer in the range 0..3.",
        );
      }

      const data = new Uint8Array(19);
      data[0] = 2;
      data[1] = step.aToB ? 1 : 0;
      const view = new DataView(data.buffer);
      view.setBigUint64(2, step.sqrtPriceLimit & U64_MAX, true);
      view.setBigUint64(10, step.sqrtPriceLimit >> 64n, true);
      data[18] = count;
      return data;
    }
    default:
      throw new RouterSdkError("INVALID_INSTRUCTION", "Unsupported route step kind.");
  }
}

/** Encode Rust RouteExactInV1 framing; account and execution checks are separate. */
export function encodeRouteExactInV1(args: RouteExactInV1Args): Uint8Array {
  assertIntegerRange(args.amountIn, "amountIn", 1n, U64_MAX);
  assertIntegerRange(args.minAmountOut, "minAmountOut", 1n, U64_MAX);
  assertIntegerRange(args.deadlineMs, "deadlineMs", 0n, U64_MAX);
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 3) {
    throw new RouterSdkError(
      "INVALID_INSTRUCTION",
      "A route must contain 1..3 steps.",
    );
  }
  const steps = Array.from(args.steps, encodeStep);
  const data = new Uint8Array(
    ROUTE_HEADER_LEN + steps.reduce((length, step) => length + step.length, 0),
  );
  data[0] = 0;
  data.set(SystemInstruction.u64ToLeBytes(args.amountIn), 1);
  data.set(SystemInstruction.u64ToLeBytes(args.minAmountOut), 9);
  data.set(SystemInstruction.u64ToLeBytes(args.deadlineMs), 17);
  data[25] = steps.length; // One-byte count, not a Borsh Vec length.
  let offset = ROUTE_HEADER_LEN;
  for (const step of steps) {
    data.set(step, offset);
    offset += step.length;
  }
  return data;
}
