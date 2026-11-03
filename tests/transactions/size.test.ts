import { MAX_ACCOUNTS_PER_TRANSACTION, RUNTIME_TX_SIZE_LIMIT, TransactionUtil, type RuntimeTransaction } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { expect, it } from "vitest";
import { TRANSACTION_SIZE_LIMIT } from "../../src/index.js";
import { assertMessageLimits, assertTransactionSize } from "../../src/transactions/size.js";
import { compileRouterMessage } from "../../src/utils.js";
import { withAccountCount } from "../helpers/transaction-limits.js";

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

it.each([1, 2])("reserves %s signatures at the 4,096-byte boundary without changing the unsigned message", (signers) => {
  const transaction = transactionOfSize(4096, signers);
  transaction.signatures = [];
  const before = TransactionUtil.serialize(transaction);
  expect(before.length).toBe(4096 - signers * 64);
  expect(assertMessageLimits(transaction.message)).toBe(4096);
  expect(TransactionUtil.serialize(transaction)).toEqual(before);
  expect(transaction.signatures).toEqual([]);
});

it.each([1, 2])("rejects 4,097 bytes after reserving %s missing signatures", (signers) => {
  const transaction = transactionOfSize(4097, signers);
  transaction.signatures = [];
  expect(TransactionUtil.serializedSize(transaction)).toBeLessThanOrEqual(4096);
  expect(() => assertMessageLimits(transaction.message)).toThrow(expect.objectContaining({
    code: "TRANSACTION_TOO_LARGE", message: "Transaction is 4097 bytes; limit is 4096.",
  }));
});

it.each([1, 2])("accepts 50 and rejects 51 message keys with %s signatures even when both packets fit the byte limit", (signers) => {
  for (const count of [50, 51]) {
    const message = withAccountCount(transactionOfSize(512, signers).message, count);
    const signatures = Array.from({ length: signers }, () => new Uint8Array(64));
    const size = TransactionUtil.serializedSize({ version: 0, message, signatures });
    expect(size).toBeLessThan(TRANSACTION_SIZE_LIMIT);
    if (count === 50) expect(assertMessageLimits(message)).toBe(size);
    else expect(() => assertMessageLimits(message)).toThrow(expect.objectContaining({
      code: "TRANSACTION_TOO_MANY_ACCOUNTS", message: "Transaction has 51 account keys; limit is 50.",
    }));
  }
  expect(MAX_ACCOUNTS_PER_TRANSACTION).toBe(50);
});

it.each([50, 51])("counts the program key among %s compiled keys while deduplicating repeated instruction positions", (count) => {
  const program = new Uint8Array(32).fill(200);
  const metas = Array.from({ length: count - 1 }, (_, index) => ({
    pubkey: new Uint8Array(32).fill(index + 1), is_signer: index < 2, is_writable: index === 0,
  }));
  const instructions = [{ program_id: program, accounts: metas.flatMap((meta) => [meta, meta]), data: new Uint8Array() }];
  const message = compileRouterMessage(instructions, base58.encode(metas[0]!.pubkey), new Uint8Array(32));
  expect(instructions[0]!.accounts.length).toBeGreaterThan(50);
  expect(message.account_keys).toHaveLength(count);
  expect(message.header.num_required_signatures).toBe(2);
  expect(message.account_keys[message.instructions[0]!.program_id_index]).toEqual(program);
  if (count === 50) expect(assertMessageLimits(message)).toBeLessThan(TRANSACTION_SIZE_LIMIT);
  else expect(() => assertMessageLimits(message)).toThrow(expect.objectContaining({ code: "TRANSACTION_TOO_MANY_ACCOUNTS" }));
});
