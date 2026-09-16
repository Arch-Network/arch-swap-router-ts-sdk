import type { AccountInfoResult, Instruction } from "@arch-network/arch-sdk";
import type { Network, NetworkMints } from "./config/networks.js";

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

/** Sizes a fixed input for an approximate receive amount, before output slippage. */
export interface QuoteForOutputRequest extends Omit<QuoteExactInRequest, "amountIn"> {
  readonly amountOut: bigint;
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
  /** Defaults to testnet. The supplied reader must use the same network. */
  readonly network?: Network;
  readonly source: RouterDataSource;
}

export interface RouterClient {
  readonly network: Network;
  /** Null until the selected network's deployment is configured. */
  readonly mints: NetworkMints | null;
  readonly supportedPairs: readonly { readonly inputMint: Address; readonly outputMint: Address }[];
  quoteExactIn(request: QuoteExactInRequest): Promise<SwapQuote>;
  /** The returned transaction still spends a fixed input; output may vary within slippage. */
  quoteForOutput(request: QuoteForOutputRequest): Promise<SwapQuote>;
}
