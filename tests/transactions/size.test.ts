import { RUNTIME_TX_SIZE_LIMIT, TransactionUtil, type RuntimeTransaction } from "@arch-network/arch-sdk";
import { expect, it } from "vitest";
import { TRANSACTION_SIZE_LIMIT } from "../../src/index.js";
import { assertTransactionSize } from "../../src/transactions/size.js";

function transactionOfSize(size: number, signers: number): RuntimeTransaction {
  const transaction: RuntimeTransaction = {
    version: 0, signatures: Array.from({ length: signers }, () => new Uint8Array(64)),
    message: {
      header: { num_required_signatures: signers, num_readonly_signed_accounts: 0, num_readonly_unsigned_accounts: 1 },
      account_keys: Array.from({ length: signers + 1 }, (_, index) => new Uint8Array(32).fill(index + 1)),
      recent_blockhash: new Uint8Array(32),
      instructions: [{ program_id_index: signers, accounts: [0], data: new Uint8Array() }],
    },
  };
  transaction.message.instructions[0]!.data = new Uint8Array(size - TransactionUtil.serializedSize(transaction));
  expect(TransactionUtil.serialize(transaction)).toHaveLength(size);
  return transaction;
}

it.each([1, 2])("accepts a 4,096-byte transaction with %s signatures", (signers) => {
  expect(assertTransactionSize(transactionOfSize(4096, signers))).toBe(4096);
});

it.each([1, 2])("rejects a 4,097-byte transaction with %s signatures", (signers) => {
  expect(() => assertTransactionSize(transactionOfSize(4097, signers))).toThrow(expect.objectContaining({
    code: "TRANSACTION_TOO_LARGE", message: "Transaction is 4097 bytes; limit is 4096.",
  }));
});

it("accepts transactions above the previous 1,232-byte cap", () => {
  expect(assertTransactionSize(transactionOfSize(1257, 2))).toBe(1257);
  expect(TRANSACTION_SIZE_LIMIT).toBe(4096);
  expect(TRANSACTION_SIZE_LIMIT).toBe(RUNTIME_TX_SIZE_LIMIT);
});
