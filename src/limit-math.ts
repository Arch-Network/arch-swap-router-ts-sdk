import { RouterSdkError } from "./errors.js";
import type { LimitOrderSide } from "./types.js";
import { U64_MAX, U128_MAX } from "./utils.js";

// Port of PropAMM program/src/limit_math.rs. Native errors map to SDK codes:
// LimitOrderZeroAmounts -> INVALID_AMOUNT, LimitOrderPriceInvalid -> INVALID_LIMIT_PRICE,
// LimitOrderMathOverflow -> MATH_OVERFLOW.
const overflow = () => new RouterSdkError("MATH_OVERFLOW", "Limit-order math exceeds native integer bounds.");
const MAX_U128_POWER_OF_TEN = 38;

function pow10(exponent: number): bigint {
  // 10^39 exceeds u128; checking first also avoids huge bigint powers.
  if (exponent > MAX_U128_POWER_OF_TEN) throw overflow();
  return 10n ** BigInt(exponent);
}

function decimals(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RouterSdkError("INVALID_REQUEST", `${field} must be a u32 integer.`);
  }
  return value;
}

function parsePrice(raw: string): readonly [bigint, bigint] {
  // Same acceptance as the native parser: ASCII digits, an optional nonempty fraction.
  if (typeof raw !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(raw)) {
    throw new RouterSdkError("INVALID_LIMIT_PRICE", "Limit price must be a positive plain decimal.");
  }
  const [whole = "", rawFraction = ""] = raw.split(".");
  // Trailing zeroes carry no price information and need no integer capacity.
  const fraction = rawFraction.replace(/0+$/, "");
  const coefficient = BigInt(whole + fraction);
  if (coefficient > U128_MAX) throw overflow();
  if (coefficient === 0n) {
    throw new RouterSdkError("INVALID_LIMIT_PRICE", "Limit price must be a positive plain decimal.");
  }
  return [coefficient, pow10(fraction.length)];
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * Smallest raw output that preserves a limit `price`, in whole quote tokens per
 * whole base token. Both sides round up. Matches native `minimum_output_at_limit`.
 */
export function minimumOutputAtLimit(
  side: LimitOrderSide,
  inputAmount: bigint,
  price: string,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  if (side !== "buy" && side !== "sell") throw new RouterSdkError("INVALID_REQUEST", "side must be buy or sell.");
  if (typeof inputAmount !== "bigint" || inputAmount < 0n || inputAmount > U64_MAX) {
    throw new RouterSdkError("INVALID_REQUEST", "inputAmount must be a u64 bigint.");
  }
  decimals(baseDecimals, "baseDecimals");
  decimals(quoteDecimals, "quoteDecimals");
  if (inputAmount === 0n) throw new RouterSdkError("INVALID_AMOUNT", "Limit-order input must be positive.");
  const [coefficient, scale] = parsePrice(price);
  const baseScale = pow10(baseDecimals);
  const quoteScale = pow10(quoteDecimals);
  const numerators = side === "buy" ? [inputAmount, baseScale, scale] : [inputAmount, coefficient, quoteScale];
  const denominators = side === "buy" ? [coefficient, quoteScale] : [baseScale, scale];
  // Reduce in native order before multiplying, so common scales cannot overflow.
  for (let n = 0; n < numerators.length; n++) {
    for (let d = 0; d < denominators.length; d++) {
      const divisor = gcd(numerators[n]!, denominators[d]!);
      numerators[n] = numerators[n]! / divisor;
      denominators[d] = denominators[d]! / divisor;
    }
  }
  // Every factor is positive, so a final bound check matches native checked_mul.
  const multiply = (factors: readonly bigint[]) => {
    const product = factors.reduce((total, factor) => total * factor, 1n);
    if (product > U128_MAX) throw overflow();
    return product;
  };
  const numerator = multiply(numerators);
  const denominator = multiply(denominators);
  const ceiling = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  if (ceiling > U64_MAX) throw overflow();
  return ceiling;
}
