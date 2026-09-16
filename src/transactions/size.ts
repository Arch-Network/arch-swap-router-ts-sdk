import {
  RUNTIME_TX_SIZE_LIMIT,
  RUNTIME_TX_VERSION,
  SanitizedMessageUtil,
  TransactionUtil,
  type Instruction,
  type RuntimeTransaction,
} from "@arch-network/arch-sdk";
import { decodeAddress } from "../accounts/address.js";
import { RouterSdkError } from "../errors/index.js";
import type { Address } from "../types.js";

/** Measure the returned bundle with every required signature; reject oversized transactions. */
export function measureSignedSize(instructions: readonly Instruction[], user: Address): number {
  const payer = decodeAddress(user);
  let message;
  try {
    message = SanitizedMessageUtil.createSanitizedMessage([...instructions], payer, new Uint8Array(32));
  } catch (cause) {
    throw new RouterSdkError("TRANSACTION_COMPILE_FAILED", "Failed to compile the instruction bundle.", { cause });
  }
  if (typeof message === "string") {
    throw new RouterSdkError("TRANSACTION_COMPILE_FAILED", message, { cause: message });
  }
  const transaction: RuntimeTransaction = {
    version: RUNTIME_TX_VERSION,
    signatures: Array.from({ length: message.header.num_required_signatures }, () => new Uint8Array(64)),
    message,
  };
  let size: number | undefined;
  try {
    size = TransactionUtil.serializedSize(transaction);
    TransactionUtil.checkTxSizeLimit(transaction);
    return size;
  } catch (cause) {
    if (size !== undefined && size > RUNTIME_TX_SIZE_LIMIT) {
      throw new RouterSdkError(
        "TRANSACTION_TOO_LARGE",
        `Signed transaction requires ${size} bytes; the limit is ${RUNTIME_TX_SIZE_LIMIT}.`,
        { cause },
      );
    }
    throw new RouterSdkError("TRANSACTION_SERIALIZATION_FAILED", "Failed to measure the signed transaction.", { cause });
  }
}
