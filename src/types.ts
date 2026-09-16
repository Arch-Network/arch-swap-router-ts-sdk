import type { AccountInfoResult, Instruction } from "@arch-network/arch-sdk";

/** Base58 public key; decoded and length-checked at the byte-conversion boundary. */
export type Address = string;

export interface RouterDataSource {
  /** Preserve request order; null means missing, while transport failures reject. */
  getAccounts(addresses: readonly Address[]): Promise<readonly (AccountInfoResult | null)[]>;
}

export interface QuoteExactInRequest {
  readonly inputMint: Address;
  readonly outputMint: Address;
  readonly amountIn: bigint;
  readonly slippageBps: number;
  readonly user: Address;
  /** Absolute Unix milliseconds, encoded into the router instruction. */
  readonly deadlineMs: number;
}

export interface SwapQuote {
  readonly inputMint: Address;
  readonly outputMint: Address;
  readonly amountIn: bigint;
  readonly estimatedAmountOut: bigint;
  readonly minAmountOut: bigint;
  readonly instructions: readonly Instruction[];
  readonly deadlineMs: number;
}

export interface RouterClientOptions {
  readonly source: RouterDataSource;
}

export interface RouterClient {
  quoteExactIn(request: QuoteExactInRequest): Promise<SwapQuote>;
}
