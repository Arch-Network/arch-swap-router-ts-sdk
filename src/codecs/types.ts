import type { PropAmmQuote } from "../types.js";

export type StepArgs =
  | { readonly kind: "vaultMint" }
  | { readonly kind: "vaultRedeem" }
  | { readonly kind: "propamm"; readonly terms: PropAmmQuote["terms"] }
  | {
      readonly kind: "clamm";
      readonly aToB: boolean;
      readonly sqrtPriceLimit: bigint;
      readonly supplementalTickArrayCount: number;
    };

export interface RouteExactInV1Args {
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly deadlineMs: bigint;
  readonly steps: readonly StepArgs[];
}

export interface RouteResultV1 {
  readonly version: 1;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}
