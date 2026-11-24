import type { RuntimeTransaction } from "@arch-network/arch-sdk";
import type { Address } from "./accounts.js";

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
