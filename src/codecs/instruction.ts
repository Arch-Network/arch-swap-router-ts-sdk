import { SystemInstruction } from "@arch-network/arch-sdk";
import { RouterSdkError } from "../errors.js";
import { assertIntegerRange, rfqExpiryBoundaryMs, U64_MAX, U128_MAX } from "../utils.js";
import type { RouteExactInV1Args, StepArgs } from "./types.js";

const ROUTE_HEADER_LEN = 26;

function encodeStep(step: StepArgs): Uint8Array {
  switch (step?.kind) {
    case "vaultMint":
      return Uint8Array.of(0);
    case "vaultRedeem":
      return Uint8Array.of(1);
    case "treasuryMint": {
      const terms = step.terms;
      if (!(terms?.issuanceId instanceof Uint8Array) || terms.issuanceId.length !== 32) {
        throw new RouterSdkError("INVALID_INSTRUCTION", "Treasury issuanceId must contain 32 bytes.");
      }
      const data = new Uint8Array(73);
      data[0] = 4;
      data.set(terms.issuanceId, 1);
      const view = new DataView(data.buffer);
      for (const [index, field] of (["quotedInput", "quotedOutput", "minInput", "maxInput", "expiryMs"] as const).entries()) {
        assertIntegerRange(terms[field], `Treasury ${field}`, 1n, U64_MAX);
        view.setBigUint64(33 + index * 8, terms[field], true);
      }
      if (terms.minInput > terms.quotedInput || terms.maxInput < terms.quotedInput) {
        throw new RouterSdkError("INVALID_INSTRUCTION", "Treasury bounds must contain the nominal input.");
      }
      return data;
    }
    case "propamm": {
      const terms = step.terms;
      if (terms?.side !== "buy" && terms?.side !== "sell") {
        throw new RouterSdkError("INVALID_INSTRUCTION", "PropAMM side must be buy or sell.");
      }
      const data = new Uint8Array(34);
      data[0] = 3;
      data[1] = terms.side === "buy" ? 0 : 1;
      const view = new DataView(data.buffer);
      for (const [index, field] of (["baseAmount", "quoteAmount", "expiryMs", "nonce"] as const).entries()) {
        assertIntegerRange(terms[field], `PropAMM ${field}`, field === "nonce" ? 0n : 1n, U64_MAX);
        view.setBigUint64(2 + index * 8, terms[field], true);
      }
      return data;
    }
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
  if (args.steps.filter((step) => step.kind === "propamm" || step.kind === "treasuryMint").length > 1) {
    throw new RouterSdkError("INVALID_INSTRUCTION", "A route may contain only one server-quoted step.");
  }
  const treasury = args.steps.find((step) => step.kind === "treasuryMint");
  if (treasury) {
    const shape = args.steps.map(step => step.kind).join(",");
    if (!["treasuryMint", "vaultRedeem,treasuryMint", "clamm,treasuryMint", "vaultRedeem,clamm,treasuryMint",
      "treasuryMint,vaultMint", "treasuryMint,clamm", "treasuryMint,clamm,vaultMint"].includes(shape)) {
      throw new RouterSdkError("INVALID_INSTRUCTION", "Treasury minting requires a supported buy or sell route shape.");
    }
    if (args.deadlineMs > rfqExpiryBoundaryMs(treasury.terms.expiryMs)) {
      throw new RouterSdkError("INVALID_INSTRUCTION", "Route deadline exceeds the treasury expiry.");
    }
  }
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
