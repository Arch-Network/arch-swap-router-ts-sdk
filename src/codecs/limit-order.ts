import { base58 } from "@scure/base";
import { RouterSdkError } from "../errors.js";
import type { CreateLimitOrderParams, LimitOrderAccount, LimitOrderStatus } from "../types.js";
import { assertIntegerRange, U64_MAX } from "../utils.js";

// PropAMM program/src/limit_order.rs and instruction.rs, frozen at v1.
export const CREATE_LIMIT_ORDER_TAG = 7;
export const CANCEL_LIMIT_ORDER_TAG = 8;
export const CREATE_LIMIT_ORDER_DATA_LEN = 58;
export const LIMIT_ORDER_ACCOUNT_LEN = 251;
const DISCRIMINATOR = new TextEncoder().encode("PROPORD1");
const STATUSES: readonly LimitOrderStatus[] = ["open", "filled", "cancelled"];

export function assertOrderId(orderId: Uint8Array): void {
  if (!(orderId instanceof Uint8Array) || orderId.length !== 32) {
    throw new RouterSdkError("INVALID_INSTRUCTION", "orderId must be a 32-byte Uint8Array.");
  }
}

/** Tag 7 followed by Borsh `CreateLimitOrderParams`: 58 bytes. */
export function encodeCreateLimitOrderData(params: CreateLimitOrderParams): Uint8Array {
  assertOrderId(params.orderId);
  if (params.side !== "buy" && params.side !== "sell") {
    throw new RouterSdkError("INVALID_INSTRUCTION", "side must be buy or sell.");
  }
  assertIntegerRange(params.inputAmount, "inputAmount", 1n, U64_MAX);
  assertIntegerRange(params.minOutputAmount, "minOutputAmount", 1n, U64_MAX);
  assertIntegerRange(params.fillAllowanceLamports, "fillAllowanceLamports", 0n, U64_MAX);
  const data = new Uint8Array(CREATE_LIMIT_ORDER_DATA_LEN);
  const view = new DataView(data.buffer);
  data[0] = CREATE_LIMIT_ORDER_TAG;
  data.set(params.orderId, 1);
  data[33] = params.side === "buy" ? 0 : 1;
  view.setBigUint64(34, params.inputAmount, true);
  view.setBigUint64(42, params.minOutputAmount, true);
  view.setBigUint64(50, params.fillAllowanceLamports, true);
  return data;
}

/** Tag 8 with no arguments. */
export function encodeCancelLimitOrderData(): Uint8Array {
  return Uint8Array.of(CANCEL_LIMIT_ORDER_TAG);
}

const invalid = (message: string) => new RouterSdkError("INVALID_ACCOUNT", `Invalid limit order: ${message}`);

/** Decode and validate as native `decode_limit_order`; owner and PDA checks are separate. */
export function decodeLimitOrder(data: Uint8Array): LimitOrderAccount {
  if (!(data instanceof Uint8Array) || data.length !== LIMIT_ORDER_ACCOUNT_LEN) {
    throw invalid(`expected ${LIMIT_ORDER_ACCOUNT_LEN} bytes.`);
  }
  if (DISCRIMINATOR.some((byte, i) => data[i] !== byte)) throw invalid("wrong discriminator.");
  if (data[8] !== 1) throw invalid(`unsupported version ${data[8]}.`);
  const status = STATUSES[data[9]!];
  if (!status) throw invalid(`unknown status ${data[9]}.`);
  const side = data[170] === 0 ? "buy" : data[170] === 1 ? "sell" : undefined;
  if (!side) throw invalid(`unknown side ${data[170]}.`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (offset: number) => base58.encode(data.slice(offset, offset + 32));
  const u64 = (offset: number) => view.getBigUint64(offset, true);
  const order: LimitOrderAccount = {
    version: 1, status, config: key(10), owner: key(42), orderId: data.slice(74, 106),
    baseMint: key(106), quoteMint: key(138), side, inputAmount: u64(171), minOutputAmount: u64(179),
    createdAt: u64(187), rentRefund: key(195), fillAllowanceLamports: u64(227),
    closedAt: u64(235), outputAmount: u64(243),
  };
  if (order.baseMint === order.quoteMint) throw invalid("base and quote mints are the same.");
  if (order.inputAmount === 0n || order.minOutputAmount === 0n) throw invalid("zero input or minimum output.");
  return order;
}
