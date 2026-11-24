import { RouterSdkError } from "./errors.js";

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

export function assertIntegerRange(
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
