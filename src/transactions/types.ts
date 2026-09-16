import type { Address } from "../types.js";

interface VaultAccounts {
  readonly vault: Address;
  readonly reserve: Address;
  readonly protocolFeeShares: Address;
  readonly managerFeeShares: Address;
  readonly eventAuthority: Address;
}

/** Private resolved addresses; the builder owns account order and privileges. */
export type ResolvedStep = { readonly outputMint: Address } & (
  | ({ readonly kind: "vaultMint" } & VaultAccounts)
  | ({
      readonly kind: "vaultRedeem";
      readonly escrow: Address;
      readonly redemptionEntry: Address;
    } & VaultAccounts)
  | {
      readonly kind: "clamm";
      readonly pool: Address;
      readonly tokenVaultA: Address;
      readonly tokenVaultB: Address;
      readonly tickArrays: readonly [Address, Address, Address];
      readonly oracle: Address;
      readonly aToB: boolean;
      readonly sqrtPriceLimit: bigint;
      /** Kept for native ABI fixture coverage; the initial quote path uses none. */
      readonly supplementalTickArrays: readonly Address[];
    }
);

export interface BuildSwapInput {
  readonly user: Address;
  readonly inputMint: Address;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly deadlineMs: number;
  readonly steps: readonly ResolvedStep[];
}
