import { RUNTIME_TX_SIZE_LIMIT as TRANSACTION_SIZE_LIMIT, TransactionUtil, type RuntimeTransaction } from "@arch-network/arch-sdk";
import { RouterSdkError } from "../errors.js";

export { TRANSACTION_SIZE_LIMIT };

/** Measure the full transaction; callers must include every required signature. */
export function assertTransactionSize(transaction: RuntimeTransaction, label = "Transaction"): number {
  const size = TransactionUtil.serializedSize(transaction);
  if (size > TRANSACTION_SIZE_LIMIT) {
    throw new RouterSdkError("TRANSACTION_TOO_LARGE", `${label} is ${size} bytes; limit is ${TRANSACTION_SIZE_LIMIT}.`);
  }
  return size;
}
