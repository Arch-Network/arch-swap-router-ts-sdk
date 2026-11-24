import type { RuntimeTransaction } from "@arch-network/arch-sdk";
import type { Address } from "./accounts.js";

export interface SwapRequestOptions {
  readonly signal?: AbortSignal;
}

export interface SwapClientOptions {
  /** PropAMM service URL, optionally including a reverse-proxy path prefix. */
  readonly baseUrl: string;
  readonly fetch?: SwapFetch;
  readonly clock?: () => number;
}

export interface SwapHttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

/** Standard fetch is compatible; hosts can also provide this smaller transport contract. */
export type SwapFetch = (url: string, init: {
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}) => Promise<SwapHttpResponse>;

export interface SwapQuoteRequest {
  readonly inputMint: Address;
  readonly outputMint: Address;
  /** Maximum input budget in raw units; actual spend can be smaller. */
  readonly maxAmountIn: bigint;
  readonly user: Address;
  /** 0..10000; omission uses the server's configured default. */
  readonly slippageBps?: number;
}

export interface SwapToken {
  readonly mint: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface SwapPair {
  readonly inputMint: Address;
  readonly outputMint: Address;
}

/** Configured connectivity, not a promise of current liquidity. */
export interface SwapPairs {
  readonly tokens: readonly SwapToken[];
  readonly pairs: readonly SwapPair[];
}

export interface SwapRemainder extends SwapToken {
  readonly estimatedAmount: bigint;
  readonly minimumAmount: bigint;
}

interface SwapLegAmounts extends SwapPair {
  readonly estimatedAmountIn: bigint;
  readonly maxAmountIn: bigint;
  readonly amountOut: bigint;
  readonly programId: Address;
}

export type SwapRouteLeg = SwapLegAmounts & (
  | { readonly venue: "treasury"; readonly side: "buy" | "sell" }
  | { readonly venue: "clamm"; readonly pool: Address; readonly aToB: boolean }
);

export interface SwapRequiredSigner {
  readonly index: number;
  readonly pubkey: Address;
  readonly role: "user" | "treasury";
}

/** A complete server-built wallet swap. Preserve the original message and blockhash. */
export interface NativeSwapQuote extends SwapPair {
  readonly quoteId: string;
  /** Server signing/submission expiry; not an on-chain execution deadline. */
  readonly expiresAtMs: number;
  readonly inputBudget: bigint;
  readonly estimatedAmountIn: bigint;
  readonly maxAmountIn: bigint;
  /** Fixed final output if execution succeeds. Do not reduce it by slippage again. */
  readonly guaranteedAmountOut: bigint;
  readonly unusedInput: SwapRemainder;
  /** Actual leftovers can differ; these fields do not impose a dust cap. */
  readonly intermediateLeftovers: readonly SwapRemainder[];
  readonly route: readonly SwapRouteLeg[];
  readonly requiredSigners: readonly SwapRequiredSigner[];
  readonly serializedSize: number;
  readonly transaction: RuntimeTransaction;
}

/** RPC acknowledgement only; the application must track chain confirmation. */
export interface SwapSubmitResult {
  readonly transactionHash: string;
}

export type SwapAttemptOutcome = "submitting" | "accepted" | "rejected" | "unknown";

export interface SwapAttempt extends SwapSubmitResult {
  readonly quoteId: string;
  readonly outcome: SwapAttemptOutcome;
  readonly attemptedAtMs: number;
  /** Metadata retention deadline, unrelated to transaction validity. */
  readonly expiresAtMs: number;
}

export interface SwapCap {
  readonly kind: "input" | "payout";
  readonly mint: Address;
  readonly amount: bigint;
  readonly limit: bigint;
}

export interface SwapCandidateFailure {
  readonly code: string;
  readonly error: string;
  readonly route: readonly Address[];
  readonly legIndex?: number;
  readonly cap?: SwapCap;
}

export interface SwapClient {
  getPairs(options?: SwapRequestOptions): Promise<SwapPairs>;
  quote(request: SwapQuoteRequest, options?: SwapRequestOptions): Promise<NativeSwapQuote>;
  /** Revalidate an opaque serialized quote without refreshing or requesting another trade. */
  restoreQuote(serialized: string): NativeSwapQuote;
  /** No automatic retry. Resolve uncertain outcomes before authorizing a fresh trade. */
  submit(quote: NativeSwapQuote, transaction: RuntimeTransaction, options?: SwapRequestOptions): Promise<SwapSubmitResult>;
  /** Missing metadata is not proof that a broadcast never happened. */
  getAttempt(quoteId: string, options?: SwapRequestOptions): Promise<SwapAttempt>;
}
