import type { AccountInfoResult, Instruction } from "@arch-network/arch-sdk";

/** Base58 public key. Runtime validation is not implemented in this scaffold. */
export type Address = string;

export interface RouterDataSource {
  /** Preserve request order; null means missing, while transport failures reject. */
  getAccounts(
    addresses: readonly Address[],
  ): Promise<readonly (AccountInfoResult | null)[]>;
}

export interface RouterDeployment {
  readonly network: "testnet" | "mainnet";
  readonly routerProgramId: Address;
  readonly vaultProgramId: Address;
  readonly clammProgramId: Address;
  readonly tokenProgramId: Address;
  readonly associatedTokenProgramId: Address;
  readonly systemProgramId: Address;
}

export interface VaultVenue {
  readonly id: string;
  readonly kind: "vault";
  readonly address: Address;
  readonly assetMint: Address;
  readonly shareMint: Address;
}

export interface ClammVenue {
  readonly id: string;
  readonly kind: "clamm";
  readonly address: Address;
  readonly tokenMintA: Address;
  readonly tokenMintB: Address;
}

export type VenueConfig = VaultVenue | ClammVenue;
export type RouteOperation = "vaultMint" | "vaultRedeem" | "clamm";

export interface RouteStep {
  readonly venueId: string;
  readonly operation: RouteOperation;
  readonly inputMint: Address;
  readonly outputMint: Address;
}

export interface RoutePlan {
  readonly id: string;
  readonly inputMint: Address;
  readonly outputMint: Address;
  readonly steps: readonly RouteStep[];
}

export interface QuoteFee {
  readonly mint: Address;
  readonly amount: bigint;
  readonly kind: string;
}

export interface HopQuote {
  readonly step: RouteStep;
  readonly amountIn: bigint;
  readonly estimatedAmountOut: bigint;
  readonly fees: readonly QuoteFee[];
}

export interface RouteQuote {
  readonly deployment: RouterDeployment;
  readonly route: RoutePlan;
  readonly amountIn: bigint;
  readonly estimatedAmountOut: bigint;
  readonly minAmountOut: bigint;
  readonly hops: readonly HopQuote[];
  readonly fees: readonly QuoteFee[];
}

export interface QuoteRoutesRequest {
  readonly inputMint: Address;
  readonly outputMint: Address;
  readonly amountIn: bigint;
  readonly slippageBps: number;
  readonly user: Address;
  /** Absolute Unix milliseconds, encoded into the router instruction. */
  readonly deadlineMs: number;
  /** Planned default: 3. Must be a positive integer once validation is implemented. */
  readonly limit?: number;
}

export interface QuotedSwap {
  readonly quote: RouteQuote;
  readonly instructions: readonly Instruction[];
  readonly deadlineMs: number;
  readonly expectedSignedSize: number;
}

export interface RouteFailure {
  readonly route: RoutePlan;
  readonly stage: "quote" | "build";
  readonly code: string;
  readonly message: string;
}

export interface QuoteRoutesResult {
  /** Response-generation time in Unix seconds, not an expiry. */
  readonly quotedAtUnixSeconds: number;
  readonly quotes: readonly QuotedSwap[];
  readonly unavailable: readonly RouteFailure[];
}

export interface RouterClientOptions {
  readonly deployment: RouterDeployment;
  readonly venues: readonly VenueConfig[];
  readonly source: RouterDataSource;
}

export interface RouterClient {
  quoteRoutesExactIn(request: QuoteRoutesRequest): Promise<QuoteRoutesResult>;
}
