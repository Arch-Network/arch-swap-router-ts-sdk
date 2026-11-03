import { MAX_ACCOUNTS_PER_TRANSACTION, RUNTIME_TX_SIZE_LIMIT as TRANSACTION_SIZE_LIMIT, TransactionUtil, type RuntimeTransaction, type SanitizedMessage } from "@arch-network/arch-sdk";
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

/** Check a compiled/validated message, reserving every eventual signature without mutation. */
export function assertMessageLimits(message: SanitizedMessage, label = "Transaction"): number {
  const signatures = Array.from({ length: message.header.num_required_signatures }, () => new Uint8Array(64));
  const size = assertTransactionSize({ version: 0, message, signatures }, label);
  // Canonical compilation and direct-RFQ validation ensure these keys are unique.
  const accounts = message.account_keys.length;
  if (accounts > MAX_ACCOUNTS_PER_TRANSACTION) {
    throw new RouterSdkError("TRANSACTION_TOO_MANY_ACCOUNTS", `${label} has ${accounts} account keys; limit is ${MAX_ACCOUNTS_PER_TRANSACTION}.`);
  }
  return size;
}
