import type { Instruction } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { assertOrderId, decodeLimitOrder, encodeCancelLimitOrderData, encodeCreateLimitOrderData } from "./codecs/limit-order.js";
import { LIMIT_ORDER_DEPLOYMENTS, NETWORKS, type Network } from "./config/networks.js";
import { RouterSdkError } from "./errors.js";
import { minimumOutputAtLimit } from "./limit-math.js";
import type { Address, LimitOrderAccount, LimitOrderMarketConfig, LimitOrderSide, RouterDataSource } from "./types.js";
import { account, accountData, decodeAddress, deriveAddress, deriveAssociatedTokenAddress as deriveAta, readAccounts, U64_MAX } from "./utils.js";

export interface LimitOrderNetworkOptions {
  /** Defaults to testnet, like `createRouterClient`. */
  readonly network?: Network;
}

function deployment(network: Network = "testnet") {
  if (!Object.hasOwn(LIMIT_ORDER_DEPLOYMENTS, network)) {
    throw new RouterSdkError("INVALID_NETWORK", `Unknown network: ${network}.`);
  }
  return { ...LIMIT_ORDER_DEPLOYMENTS[network], programs: NETWORKS[network].programs };
}

/** Order PDA: `["limit_order", config, owner, orderId]`. */
export function deriveLimitOrderAddress(owner: Address, orderId: Uint8Array, options: LimitOrderNetworkOptions = {}): Address {
  assertOrderId(orderId);
  const { programId, config } = deployment(options.network);
  return deriveAddress(programId, "limit_order", decodeAddress(config), decodeAddress(owner), orderId);
}

/** Escrow token-account PDA: `["limit_escrow", order]`. */
export function deriveLimitOrderEscrowAddress(order: Address, options: LimitOrderNetworkOptions = {}): Address {
  return deriveAddress(deployment(options.network).programId, "limit_escrow", decodeAddress(order));
}

/** The owner's canonical APL associated token account for `mint`. */
export function deriveAssociatedTokenAddress(owner: Address, mint: Address, options: LimitOrderNetworkOptions = {}): Address {
  return deriveAta(owner, mint, deployment(options.network).programs);
}

/** 32 random bytes from Web Crypto, for a new order's identity. */
export function generateLimitOrderId(): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new RouterSdkError("CRYPTO_UNAVAILABLE", "Web Crypto getRandomValues is required to generate an order ID.");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export type CreateLimitOrderRequest = LimitOrderNetworkOptions & {
  /** Sole signer and fee payer; also the recorded rent refund. */
  readonly owner: Address;
  readonly market: { readonly baseMint: Address; readonly quoteMint: Address };
  readonly side: LimitOrderSide;
  /** Raw input units: quote tokens for a buy, base tokens for a sell. */
  readonly inputAmount: bigint;
  readonly orderId: Uint8Array;
  readonly fillAllowanceLamports: bigint;
} & (
  | {
      /** Whole quote tokens per whole base token, e.g. "100000.5". */
      readonly limitPrice: string;
      readonly baseDecimals: number;
      readonly quoteDecimals: number;
      readonly minOutputAmount?: never;
    }
  | { readonly minOutputAmount: bigint; readonly limitPrice?: never }
);

export interface CreateLimitOrderInstruction {
  readonly instruction: Instruction;
  readonly order: Address;
  readonly escrow: Address;
  readonly minOutputAmount: bigint;
}

/** Owner-paid `create_limit_order`; account order and privileges follow the PropAMM IDL. */
export function buildCreateLimitOrderInstruction(request: CreateLimitOrderRequest): CreateLimitOrderInstruction {
  const { owner, market: { baseMint, quoteMint }, side, inputAmount, orderId, fillAllowanceLamports } = request;
  const { programId, config, programs } = deployment(request.network);
  for (const address of [owner, baseMint, quoteMint]) decodeAddress(address);
  if (baseMint === quoteMint) throw new RouterSdkError("INVALID_INSTRUCTION", "Base and quote mints must differ.");
  const minOutputAmount = request.limitPrice !== undefined
    ? minimumOutputAtLimit(side, inputAmount, request.limitPrice, request.baseDecimals, request.quoteDecimals)
    : request.minOutputAmount;
  const data = encodeCreateLimitOrderData({ orderId, side, inputAmount, minOutputAmount, fillAllowanceLamports });
  const order = deriveLimitOrderAddress(owner, orderId, request);
  const escrow = deriveLimitOrderEscrowAddress(order, request);
  const [inputMint, outputMint] = side === "buy" ? [quoteMint, baseMint] : [baseMint, quoteMint];
  const instruction: Instruction = {
    program_id: decodeAddress(programId),
    accounts: [
      account(config), account(owner, true, true), account(owner, false, true),
      account(order, true), account(escrow, true), account(baseMint), account(quoteMint),
      account(deriveAta(owner, inputMint, programs), true), account(deriveAta(owner, outputMint, programs), true),
      account(programs.tokenProgramId), account(programs.systemProgramId), account(programs.associatedTokenProgramId),
    ],
    data,
  };
  return { instruction, order, escrow, minOutputAmount };
}

/** Owner-paid `cancel_limit_order` for an open order loaded from chain. */
export function buildCancelLimitOrderInstruction(order: LimitOrderAccount, options: LimitOrderNetworkOptions = {}): Instruction {
  const { programId, config, programs } = deployment(options.network);
  if (order?.status !== "open") throw new RouterSdkError("INVALID_INSTRUCTION", "Only open orders can be cancelled.");
  if (order.config !== config) throw new RouterSdkError("INVALID_INSTRUCTION", "Order belongs to another PropAMM config.");
  const address = deriveLimitOrderAddress(order.owner, order.orderId, options);
  const inputMint = order.side === "buy" ? order.quoteMint : order.baseMint;
  return {
    program_id: decodeAddress(programId),
    accounts: [
      account(order.owner, true, true), account(order.owner, false, true), account(address, true),
      account(deriveLimitOrderEscrowAddress(address, options), true), account(inputMint),
      account(deriveAta(order.owner, inputMint, programs), true), account(order.rentRefund, true),
      account(programs.tokenProgramId), account(programs.systemProgramId), account(programs.associatedTokenProgramId),
    ],
    data: encodeCancelLimitOrderData(),
  };
}

/**
 * Read one order through the injected reader. Returns null when it does not
 * exist yet; rejects wrong owners, malformed data and non-canonical addresses.
 */
export async function loadLimitOrder(source: RouterDataSource, order: Address, options: LimitOrderNetworkOptions = {}): Promise<LimitOrderAccount | null> {
  const { programId, config, programs } = deployment(options.network);
  decodeAddress(order);
  const accounts = await readAccounts(source, [order]);
  const info = accounts.get(order);
  if (!info || (base58.encode(info.owner) === programs.systemProgramId && info.data.length === 0 && !info.is_executable)) {
    return null;
  }
  const decoded = decodeLimitOrder(accountData(accounts, order, programId));
  if (decoded.config !== config || deriveLimitOrderAddress(decoded.owner, decoded.orderId, options) !== order) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Limit order identity does not match its address or config.");
  }
  return decoded;
}

export interface LimitOrderPreviewRequest {
  /**
   * The `/orders/config` entry for this pair, which also supplies token decimals.
   * Undefined when the server lists none: the server never fills such an order,
   * so the preview reports only `UNSUPPORTED_MARKET`.
   */
  readonly market: LimitOrderMarketConfig | undefined;
  readonly side: LimitOrderSide;
  readonly inputAmount: bigint;
  readonly limitPrice: string;
  /** `/orders/config` `fillFeeLamports`. */
  readonly fillFeeLamports: bigint;
}

export type LimitOrderPreviewErrorCode =
  | "UNSUPPORTED_MARKET" | "BELOW_MINIMUM_INPUT" | "INVALID_AMOUNT" | "INVALID_LIMIT_PRICE" | "MATH_OVERFLOW";

export interface LimitOrderPreview {
  /** Null when the price or input cannot produce a minimum. */
  readonly minOutputAmount: bigint | null;
  /** The trigger's fill fee; a smaller allowance means the owner fills it. */
  readonly fillAllowanceLamports: bigint;
  /** Empty when the order can be created and filled by the server. */
  readonly errors: readonly { readonly code: LimitOrderPreviewErrorCode; readonly message: string }[];
}

/** Pure form validation; no reads or provider calls. */
export function previewLimitOrder(request: LimitOrderPreviewRequest): LimitOrderPreview {
  const { market, side, inputAmount, fillFeeLamports } = request;
  if (typeof fillFeeLamports !== "bigint" || fillFeeLamports < 0n || fillFeeLamports > U64_MAX) {
    throw new RouterSdkError("INVALID_REQUEST", "fillFeeLamports must be a u64 bigint.");
  }
  if (!market) {
    return {
      minOutputAmount: null, fillAllowanceLamports: fillFeeLamports,
      errors: [{ code: "UNSUPPORTED_MARKET", message: "The order server does not accept limit orders for this market." }],
    };
  }
  const errors: { code: LimitOrderPreviewErrorCode; message: string }[] = [];
  let minOutputAmount: bigint | null = null;
  try {
    minOutputAmount = minimumOutputAtLimit(side, inputAmount, request.limitPrice, market.baseDecimals, market.quoteDecimals);
  } catch (error) {
    if (!(error instanceof RouterSdkError) || !["INVALID_AMOUNT", "INVALID_LIMIT_PRICE", "MATH_OVERFLOW"].includes(error.code)) {
      throw error;
    }
    errors.push({ code: error.code as LimitOrderPreviewErrorCode, message: error.message });
  }
  const [minimum, symbol] = side === "buy" ? [market.minBuyInput, market.quoteSymbol] : [market.minSellInput, market.baseSymbol];
  if (inputAmount < minimum) {
    errors.push({ code: "BELOW_MINIMUM_INPUT", message: `Input must be at least ${minimum} raw ${symbol} units.` });
  }
  return { minOutputAmount, fillAllowanceLamports: fillFeeLamports, errors };
}
