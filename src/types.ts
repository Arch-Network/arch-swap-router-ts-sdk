import type { AccountInfoResult, Instruction, RuntimeTransaction } from "@arch-network/arch-sdk";
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
  /** Mainnet Prime → aUSD sells: compare exits, require redemption, or require the direct maker. */
  readonly routePreference?: "auto" | "vault" | "propamm";
  readonly slippageBps: number;
  readonly user: Address;
  /** Absolute Unix milliseconds: encoded by router instructions, a client submission deadline for server transactions. */
  readonly deadlineMs: number;
}

/** Sizes a fixed input for an approximate receive amount, before output slippage. */
export interface QuoteForOutputRequest extends Omit<QuoteExactInRequest, "amountIn"> {
  readonly amountOut: bigint;
}

/** Original maker terms and the execution estimate (including inventory skew). */
export interface PropAmmQuote {
  readonly kind?: "propamm";
  readonly quoteId: string;
  /** Quote signer from this RFQ's native instruction; may change after rotation. */
  readonly quoteSigner: Address;
  readonly terms: {
    readonly side: "buy" | "sell";
    readonly baseAmount: bigint;
    readonly quoteAmount: bigint;
    readonly expiryMs: bigint;
    readonly nonce: bigint;
  };
  readonly estimatedAmountOut: bigint;
}

/** Input interval issued by the server; applications must preserve it unchanged. */
export interface TreasuryAuthorization {
  readonly version: 1;
  readonly minAmountIn: bigint;
  readonly maxAmountIn: bigint;
}

/** Router tag 4 terms; all amounts are raw token units. */
export interface TreasuryMintTerms {
  readonly issuanceId: Uint8Array;
  readonly quotedInput: bigint;
  readonly quotedOutput: bigint;
  readonly minInput: bigint;
  readonly maxInput: bigint;
  readonly expiryMs: bigint;
}

export interface PropAmmQuoteProvider {
  quoteExactIn(request: Pick<QuoteExactInRequest, "inputMint" | "outputMint" | "amountIn" | "user">): Promise<PropAmmQuote>;
}

/** Original unsigned server transaction and metadata; transport and lossless JSON decoding belong to the provider. */
export interface DirectRfqQuote {
  readonly transaction: RuntimeTransaction;
  readonly quoteId: string;
  /** Server expiry in Unix milliseconds. */
  readonly expiresAtMs: bigint;
  readonly estimatedAmountOut: bigint;
  /** Required for routed treasury mints; preserve the server-issued bounds. Omit on native swaps. */
  readonly treasuryAuthorization?: TreasuryAuthorization;
}

export interface DirectRfqQuoteProvider {
  quoteExactIn(request: QuoteExactInRequest): Promise<DirectRfqQuote>;
}

/** One hop of the selected route, with amounts in raw token units. */
export interface SwapHop {
  readonly kind: "vaultMint" | "vaultRedeem" | "clamm" | "propamm" | "treasuryMint";
  readonly inputMint: Address;
  readonly outputMint: Address;
  /** Fixed for the first hop; the preceding hop's estimated output thereafter. */
  readonly amountIn: bigint;
  readonly estimatedAmountOut: bigint;
}

interface SwapQuoteBase {
  readonly inputMint: Address;
  readonly outputMint: Address;
  readonly amountIn: bigint;
  readonly estimatedAmountOut: bigint;
  readonly minAmountOut: bigint;
  readonly hops: readonly SwapHop[];
  readonly deadlineMs: number;
}

export interface RouterSwapQuote extends SwapQuoteBase {
  /** Existing router quotes omit this field. */
  readonly execution?: "router";
  readonly instructions: readonly Instruction[];
  /** Present when submission needs the RFQ server's native quote or treasury signature. */
  readonly rfq?: { readonly quoteId: string };
}

export interface ServerTransactionSwapQuote extends SwapQuoteBase {
  readonly execution: "serverTransaction";
  /** Sign the original message; do not recompile it, replace its blockhash or append instructions. */
  readonly transaction: RuntimeTransaction;
  readonly rfq: { readonly quoteId: string };
}

export type SwapQuote = RouterSwapQuote | ServerTransactionSwapQuote;

export interface RouterClientOptions {
  /** Defaults to testnet. The supplied reader must use the same network. */
  readonly network?: Network;
  readonly source: RouterDataSource;
  /** Optional exact-input alternative to CLAMM; must use the selected network. Each RFQ waits at most 2s. */
  readonly propAmmQuoteProvider?: PropAmmQuoteProvider;
  /** Enables built-in mainnet ETH/HYPE routes and Prime → aUSD inventory sells. */
  readonly directRfqQuoteProvider?: DirectRfqQuoteProvider;
}

export interface RouterClient {
  readonly network: Network;
  /** Null until the selected network's deployment is configured. */
  readonly mints: NetworkMints | null;
  readonly supportedPairs: readonly { readonly inputMint: Address; readonly outputMint: Address }[];
  quoteExactIn(request: QuoteExactInRequest): Promise<RouterSwapQuote>;
  /** The returned transaction still spends a fixed input; output may vary within slippage. */
  quoteForOutput(request: QuoteForOutputRequest): Promise<RouterSwapQuote>;
}

export type LimitOrderSide = "buy" | "sell";
/** On-chain order status; terminal accounts are retained as history. */
export type LimitOrderStatus = "open" | "filled" | "cancelled";

/** `CreateLimitOrderParams`, in native field order. Token amounts are raw units. */
export interface CreateLimitOrderParams {
  /** 32 bytes; part of the order PDA seeds, so never reuse one for the same owner. */
  readonly orderId: Uint8Array;
  readonly side: LimitOrderSide;
  readonly inputAmount: bigint;
  readonly minOutputAmount: bigint;
  /** Prepaid by the owner, paid to whoever funds the fill, refunded on cancel. */
  readonly fillAllowanceLamports: bigint;
}

/** Decoded `LimitOrder` v1 account (251 bytes, discriminator `PROPORD1`). */
export interface LimitOrderAccount extends CreateLimitOrderParams {
  readonly version: 1;
  readonly status: LimitOrderStatus;
  readonly config: Address;
  readonly owner: Address;
  readonly baseMint: Address;
  readonly quoteMint: Address;
  /** Unix seconds, chain clock. */
  readonly createdAt: bigint;
  /** Initial funder; receives escrow rent and any unused fill allowance. */
  readonly rentRefund: Address;
  /** Unix seconds of the fill or cancel; 0 while open. */
  readonly closedAt: bigint;
  /** Actual post-skew fill payout; 0 while open or after a cancel. */
  readonly outputAmount: bigint;
}

/** One `GET /orders/config` market. */
export interface LimitOrderMarketConfig {
  readonly baseMint: Address;
  readonly quoteMint: Address;
  readonly baseSymbol: string;
  readonly quoteSymbol: string;
  /** Mint decimals; needed to turn a limit price into a minimum output. */
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  /** Smallest buy input, in raw quote-token units. */
  readonly minBuyInput: bigint;
  /** Smallest sell input, in raw base-token units. */
  readonly minSellInput: bigint;
}

/** `GET /orders/config`. */
export interface LimitOrderServerConfig {
  /** Whether the server fills orders automatically; otherwise use `fill`. */
  readonly triggerEnabled: boolean;
  /** Smallest allowance the trigger fills, and the default allowance. */
  readonly fillFeeLamports: bigint;
  readonly markets: readonly LimitOrderMarketConfig[];
}

/** `POST /orders/list` request. */
export interface LimitOrderListRequest {
  readonly owner: Address;
  /** `closed` means filled or cancelled; omit for both. */
  readonly status?: "open" | "closed";
  /** `nextCursor` from the previous page. */
  readonly cursor?: string;
  /** 1..100; the server defaults to 50. */
  readonly limit?: number;
}

/** One `POST /orders/list` order, newest first. */
export interface LimitOrderSummary {
  readonly order: Address;
  /** 64 hex characters, as served. */
  readonly orderId: string;
  readonly owner: Address;
  readonly baseMint: Address;
  readonly quoteMint: Address;
  readonly side: LimitOrderSide;
  readonly inputAmount: bigint;
  readonly minOutputAmount: bigint;
  readonly fillAllowanceLamports: bigint;
  readonly state: LimitOrderStatus;
  /** Unix seconds. */
  readonly createdAt: bigint;
  /** Unix seconds; present once filled or cancelled. */
  readonly closedAt?: bigint;
  /** Actual payout; present only when filled. */
  readonly outputAmount?: bigint;
}

export interface LimitOrderListResult {
  readonly orders: readonly LimitOrderSummary[];
  readonly nextCursor?: string;
}

/** `POST /orders/fill` request. */
export interface LimitOrderFillRequest {
  readonly order: Address;
  /** Fee payer; receives the order's fill allowance when the fill lands. */
  readonly payer: Address;
}

/** `POST /orders/fill` response. */
export interface LimitOrderFill {
  readonly order: Address;
  /** Maker-signed; the payer's signature slot is zeroed. */
  readonly transaction: RuntimeTransaction;
  readonly payerSignatureIndex: number;
  /** Post-skew payout, at least `minOutputAmount`. */
  readonly outputAmount: bigint;
  readonly minOutputAmount: bigint;
  /** Unix milliseconds; send before this. */
  readonly expiresAtMs: bigint;
}

/** Application-owned access to the PropAMM order server; transport and lossless JSON decoding belong to the provider. */
export interface LimitOrderProvider {
  config(): Promise<LimitOrderServerConfig>;
  list(request: LimitOrderListRequest): Promise<LimitOrderListResult>;
  /** Reject when the server answers 422 `order_not_fillable`. */
  fill(request: LimitOrderFillRequest): Promise<LimitOrderFill>;
}
