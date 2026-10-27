import { RUNTIME_TX_SIZE_LIMIT, TransactionUtil } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { MAINNET_AETH_USD as market } from "./config/aeth-usd.js";
import { RouterSdkError } from "./errors.js";
import type { DirectRfqQuote, QuoteExactInRequest, ServerTransactionSwapQuote } from "./types.js";
import { decodeAddress, deriveAddress, deriveProgramAddress, U64_MAX } from "./utils.js";

function requireRfq(valid: boolean, message: string): void {
  if (!valid) throw new RouterSdkError("INVALID_RFQ", message);
}

function positiveU64(value: bigint): boolean {
  return typeof value === "bigint" && value > 0n && value <= U64_MAX;
}

function bytes(value: Uint8Array, length: number): boolean {
  return value instanceof Uint8Array && value.length === length;
}

/** Validate the fixed treasury-buy template without recompiling the server's message. */
export function normalizeAethUsdBuy(request: QuoteExactInRequest, quote: DirectRfqQuote): ServerTransactionSwapQuote {
  if (request.inputMint !== market.quoteMint || request.outputMint !== market.baseMint) {
    throw new RouterSdkError("UNSUPPORTED_PAIR", "Treasury buys require mainnet aUSD → aETH.");
  }
  const user = decodeAddress(request.user);
  if (!positiveU64(request.amountIn) || !Number.isInteger(request.slippageBps)
    || request.slippageBps < 0 || request.slippageBps > 9999
    || !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs < 0) {
    throw new RouterSdkError("INVALID_REQUEST", "Invalid exact-input amount, slippage or deadline.");
  }
  requireRfq(typeof quote?.quoteId === "string" && quote.quoteId.trim().length > 0, "Missing RFQ quote ID.");
  requireRfq(positiveU64(quote.expiresAtMs) && positiveU64(quote.estimatedAmountOut), "Invalid RFQ expiry or output amount.");
  const deadlineMs = Number(quote.expiresAtMs < BigInt(request.deadlineMs) ? quote.expiresAtMs : BigInt(request.deadlineMs));

  const transaction = quote.transaction;
  const message = transaction?.message;
  const header = message?.header;
  requireRfq(transaction?.version === 0 && Array.isArray(transaction.signatures) && transaction.signatures.length === 0,
    "Expected an unsigned version-0 transaction.");
  requireRfq(!!header && header.num_required_signatures === 2 && header.num_readonly_signed_accounts === 0
    && Number.isInteger(header.num_readonly_unsigned_accounts) && header.num_readonly_unsigned_accounts >= 0
    && Array.isArray(message.account_keys) && message.account_keys.length >= 2 && message.account_keys.length <= 256
    && header.num_readonly_unsigned_accounts <= message.account_keys.length - 2
    && bytes(message.recent_blockhash, 32) && Array.isArray(message.instructions) && message.instructions.length === 2,
  "Invalid treasury-buy message framing.");
  for (const key of message.account_keys) requireRfq(bytes(key, 32), "Invalid message public key.");
  const keys = message.account_keys.map(base58.encode);
  requireRfq(new Set(keys).size === keys.length, "Repeated message public key.");
  requireRfq(keys[0] === request.user && keys[1] === market.treasuryAuthority, "Unexpected fee payer or treasury signer.");
  for (const instruction of message.instructions) {
    requireRfq(!!instruction && Number.isInteger(instruction.program_id_index) && instruction.program_id_index >= 0
      && instruction.program_id_index < keys.length && Array.isArray(instruction.accounts) && instruction.accounts.length <= 11
      && instruction.data instanceof Uint8Array && instruction.data.length <= 73, "Invalid compiled instruction.");
    for (const index of instruction.accounts) {
      requireRfq(Number.isInteger(index) && index >= 0 && index < keys.length, "Invalid instruction account index.");
    }
  }
  const payment = message.instructions[0]!;
  const mint = message.instructions[1]!;
  requireRfq(keys[payment.program_id_index] === market.tokenProgramId && payment.accounts.length === 3
    && bytes(payment.data, 9) && payment.data[0] === 3, "Expected the canonical aUSD transfer.");
  requireRfq(keys[mint.program_id_index] === market.bridgeProgramId && mint.accounts.length === 11
    && bytes(mint.data, 73) && mint.data[0] === 21, "Expected the canonical treasury mint.");
  // The RFQ response is unsigned; reserve space for both eventual signatures.
  const signedSize = TransactionUtil.serializedSize({ ...transaction, signatures: [new Uint8Array(64), new Uint8Array(64)] });
  if (signedSize > RUNTIME_TX_SIZE_LIMIT) {
    throw new RouterSdkError("TRANSACTION_TOO_LARGE", `Treasury buy is ${signedSize} bytes; limit is ${RUNTIME_TX_SIZE_LIMIT}.`);
  }

  const paymentData = new DataView(payment.data.buffer, payment.data.byteOffset, payment.data.byteLength);
  const mintData = new DataView(mint.data.buffer, mint.data.byteOffset, mint.data.byteLength);
  const amountOut = mintData.getBigUint64(33, true);
  requireRfq(paymentData.getBigUint64(1, true) === request.amountIn, "Payment differs from the requested input.");
  requireRfq(amountOut > 0n && amountOut === quote.estimatedAmountOut, "Mint payout differs from the quoted output.");
  requireRfq(base58.encode(mint.data.subarray(41)) === request.user, "Mint data names another recipient.");

  const ata = (mintKey: string) => deriveProgramAddress([
    user, decodeAddress(market.tokenProgramId), decodeAddress(mintKey),
  ], market.associatedTokenProgramId)[0];
  const paymentKeys = [ata(market.quoteMint), market.quoteVault, request.user];
  const mintKeys = [
    market.treasuryAuthority,
    deriveAddress(market.bridgeProgramId, "config"),
    deriveAddress(market.bridgeProgramId, "asset", decodeAddress(market.baseMint)),
    deriveAddress(market.bridgeProgramId, "treasury_mint", mint.data.subarray(1, 33)),
    market.baseMint,
    deriveAddress(market.bridgeProgramId, "mint-authority", decodeAddress(market.baseMint)),
    request.user, ata(market.baseMint), market.tokenProgramId,
    market.associatedTokenProgramId, market.systemProgramId,
  ];
  requireRfq(payment.accounts.every((index, i) => keys[index] === paymentKeys[i])
    && mint.accounts.every((index, i) => keys[index] === mintKeys[i]), "Unexpected payment or mint accounts.");
  const expectedKeys = new Set([...paymentKeys, ...mintKeys, market.tokenProgramId, market.bridgeProgramId]);
  requireRfq(expectedKeys.size === keys.length && keys.every(key => expectedKeys.has(key)), "Unexpected message accounts.");
  const writable = new Set([request.user, market.treasuryAuthority, paymentKeys[0]!, market.quoteVault,
    mintKeys[3]!, market.baseMint, mintKeys[7]!]);
  keys.forEach((key, index) => requireRfq((index < keys.length - header.num_readonly_unsigned_accounts) === writable.has(key),
    "Unexpected account privileges."));
  if (deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Treasury-buy quote deadline has expired.");

  return {
    execution: "serverTransaction",
    inputMint: request.inputMint, outputMint: request.outputMint, amountIn: request.amountIn,
    estimatedAmountOut: amountOut, minAmountOut: amountOut, deadlineMs,
    hops: [{ kind: "treasuryMint", inputMint: request.inputMint, outputMint: request.outputMint,
      amountIn: request.amountIn, estimatedAmountOut: amountOut }],
    transaction, rfq: { quoteId: quote.quoteId },
  };
}
