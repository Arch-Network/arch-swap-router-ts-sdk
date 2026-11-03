import { base58 } from "@scure/base";
import { MAINNET_AETH_USD } from "./config/aeth-usd.js";
import { RouterSdkError } from "./errors.js";
import type { DirectRfqMarket, DirectRfqQuote, PropAmmQuote, QuoteExactInRequest, ServerTransactionSwapQuote } from "./types.js";
import type { TreasuryMintQuote } from "./treasury-mint.js";
import { assertMessageLimits } from "./transactions/size.js";
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

function readDirectRfq(request: QuoteExactInRequest, quote: DirectRfqQuote, serverSigner: string, instructionCount: number) {
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
    && bytes(message.recent_blockhash, 32) && Array.isArray(message.instructions) && message.instructions.length === instructionCount,
    "Invalid direct RFQ message framing.");
  for (const key of message.account_keys) requireRfq(bytes(key, 32), "Invalid message public key.");
  const keys = message.account_keys.map(base58.encode);
  requireRfq(new Set(keys).size === keys.length, "Repeated message public key.");
  requireRfq(keys[0] === request.user && keys[1] === serverSigner, "Unexpected RFQ fee payer or server signer.");
  for (const instruction of message.instructions) {
    requireRfq(!!instruction && Number.isInteger(instruction.program_id_index) && instruction.program_id_index >= 0
      && instruction.program_id_index < keys.length && Array.isArray(instruction.accounts) && instruction.accounts.length <= 13
      && instruction.data instanceof Uint8Array && instruction.data.length <= 73, "Invalid compiled instruction.");
    for (const index of instruction.accounts) {
      requireRfq(Number.isInteger(index) && index >= 0 && index < keys.length, "Invalid instruction account index.");
    }
  }
  // The RFQ response is unsigned; reserve space for both eventual signatures.
  assertMessageLimits(message, "Direct RFQ transaction");
  return { user, deadlineMs, transaction, message, header, keys };
}

function userAta(market: DirectRfqMarket, user: Uint8Array, mint: string): string {
  return deriveProgramAddress([
    user, decodeAddress(market.tokenProgramId), decodeAddress(mint),
  ], market.associatedTokenProgramId)[0];
}

function validateAccounts(keys: readonly string[], readonlyUnsigned: number, expected: readonly string[], writable: readonly string[]): void {
  const expectedKeys = new Set(expected);
  requireRfq(expectedKeys.size === keys.length && keys.every(key => expectedKeys.has(key)), "Unexpected message accounts.");
  const writableKeys = new Set(writable);
  keys.forEach((key, index) => requireRfq((index < keys.length - readonlyUnsigned) === writableKeys.has(key),
    "Unexpected account privileges."));
}

/** Decode the canonical native template shared by direct and composable mints. */
function decodeTreasuryTemplate(request: QuoteExactInRequest, quote: DirectRfqQuote, market: DirectRfqMarket = MAINNET_AETH_USD) {
  if (request.inputMint !== market.quoteMint || request.outputMint !== market.baseMint) {
    throw new RouterSdkError("UNSUPPORTED_PAIR", "Treasury buys require mainnet aUSD → aETH.");
  }
  const { user, deadlineMs, transaction, message, header, keys } = readDirectRfq(request, quote, market.treasuryAuthority, 2);
  const payment = message.instructions[0]!;
  const mint = message.instructions[1]!;
  requireRfq(keys[payment.program_id_index] === market.tokenProgramId && payment.accounts.length === 3
    && bytes(payment.data, 9) && payment.data[0] === 3, "Expected the canonical aUSD transfer.");
  requireRfq(keys[mint.program_id_index] === market.bridgeProgramId && mint.accounts.length === 11
    && bytes(mint.data, 73) && mint.data[0] === 21, "Expected the canonical treasury mint.");
  const paymentData = new DataView(payment.data.buffer, payment.data.byteOffset, payment.data.byteLength);
  const mintData = new DataView(mint.data.buffer, mint.data.byteOffset, mint.data.byteLength);
  const amountOut = mintData.getBigUint64(33, true);
  requireRfq(paymentData.getBigUint64(1, true) === request.amountIn, "Payment differs from the requested input.");
  requireRfq(amountOut > 0n && amountOut === quote.estimatedAmountOut, "Mint payout differs from the quoted output.");
  requireRfq(base58.encode(mint.data.subarray(41)) === request.user, "Mint data names another recipient.");

  const quoteVault = deriveAddress(market.programId, "vault", decodeAddress(market.config), decodeAddress(market.quoteMint));
  const paymentKeys = [userAta(market, user, market.quoteMint), quoteVault, request.user];
  const mintKeys = [
    market.treasuryAuthority,
    deriveAddress(market.bridgeProgramId, "config"),
    deriveAddress(market.bridgeProgramId, "asset", decodeAddress(market.baseMint)),
    deriveAddress(market.bridgeProgramId, "treasury_mint", mint.data.subarray(1, 33)),
    market.baseMint,
    deriveAddress(market.bridgeProgramId, "mint-authority", decodeAddress(market.baseMint)),
    request.user, userAta(market, user, market.baseMint), market.tokenProgramId,
    market.associatedTokenProgramId, market.systemProgramId,
  ];
  requireRfq(payment.accounts.every((index, i) => keys[index] === paymentKeys[i])
    && mint.accounts.every((index, i) => keys[index] === mintKeys[i]), "Unexpected payment or mint accounts.");
  validateAccounts(keys, header.num_readonly_unsigned_accounts,
    [...paymentKeys, ...mintKeys, market.tokenProgramId, market.bridgeProgramId],
    [request.user, market.treasuryAuthority, paymentKeys[0]!, quoteVault, mintKeys[3]!, market.baseMint, mintKeys[7]!]);
  if (deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Treasury-buy quote deadline has expired.");

  return { transaction, deadlineMs, amountOut, issuanceId: mint.data.slice(1, 33) };
}

/** Validate the fixed treasury-buy template without recompiling the server's message. */
export function normalizeDirectRfqBuy(request: QuoteExactInRequest, quote: DirectRfqQuote, market: DirectRfqMarket = MAINNET_AETH_USD): ServerTransactionSwapQuote {
  const { transaction, deadlineMs, amountOut } = decodeTreasuryTemplate(request, quote, market);

  return {
    execution: "serverTransaction",
    inputMint: request.inputMint, outputMint: request.outputMint, amountIn: request.amountIn,
    estimatedAmountOut: amountOut, minAmountOut: amountOut, deadlineMs,
    hops: [{ kind: "treasuryMint", inputMint: request.inputMint, outputMint: request.outputMint,
      amountIn: request.amountIn, estimatedAmountOut: amountOut }],
    transaction, rfq: { quoteId: quote.quoteId },
  };
}

/** Pinned native ExecuteTrade for either side, with explicit minimum and creation accounts. */
function normalizeNativeSwap(request: QuoteExactInRequest, quote: DirectRfqQuote, market: DirectRfqMarket = MAINNET_AETH_USD): ServerTransactionSwapQuote {
  const buy = request.inputMint === market.quoteMint && request.outputMint === market.baseMint;
  const sell = request.inputMint === market.baseMint && request.outputMint === market.quoteMint;
  if (!buy && !sell) {
    throw new RouterSdkError("UNSUPPORTED_PAIR", "Native swaps require mainnet aETH ↔ aUSD.");
  }
  const { user, deadlineMs, transaction, message, header, keys } = readDirectRfq(request, quote, market.quoteSigner, 1);
  const trade = message.instructions[0]!;
  requireRfq(keys[trade.program_id_index] === market.programId && trade.accounts.length === 13
    && bytes(trade.data, 50) && trade.data[0] === 2 && trade.data[1] === (buy ? 0 : 1), "Expected the canonical native PropAMM trade.");
  const data = new DataView(trade.data.buffer, trade.data.byteOffset, trade.data.byteLength);
  requireRfq(data.getBigUint64(buy ? 10 : 2, true) === request.amountIn && data.getBigUint64(34, true) === request.amountIn,
    "Quoted or actual swap input differs from the requested amount.");
  requireRfq(data.getBigUint64(buy ? 2 : 10, true) > 0n, "Quoted swap output must be positive.");
  requireRfq(data.getBigUint64(18, true) === quote.expiresAtMs, "Swap expiry differs from the RFQ metadata.");
  const minAmountOut = data.getBigUint64(42, true);
  // The estimate includes inventory skew; use its payout for the slippage floor.
  const requestedMinimum = quote.estimatedAmountOut * BigInt(10_000 - request.slippageBps) / 10_000n;
  requireRfq(minAmountOut > 0n && minAmountOut >= requestedMinimum && minAmountOut <= quote.estimatedAmountOut,
    "Signed minimum does not satisfy the requested slippage or execution estimate.");

  const baseVault = deriveAddress(market.programId, "vault", decodeAddress(market.config), decodeAddress(market.baseMint));
  const quoteVault = deriveAddress(market.programId, "vault", decodeAddress(market.config), decodeAddress(market.quoteMint));
  const tradeKeys = [
    market.config, market.quoteSigner, request.user,
    deriveAddress(market.programId, "user_nonce", decodeAddress(market.config), user),
    baseVault, quoteVault, userAta(market, user, market.baseMint), userAta(market, user, market.quoteMint),
    market.baseMint, market.quoteMint, market.tokenProgramId, market.systemProgramId, market.associatedTokenProgramId,
  ];
  requireRfq(trade.accounts.every((index, i) => keys[index] === tradeKeys[i]), "Unexpected native swap accounts.");
  validateAccounts(keys, header.num_readonly_unsigned_accounts, [...tradeKeys, market.programId], tradeKeys.slice(0, 12));
  if (deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Native swap quote deadline has expired.");

  return {
    execution: "serverTransaction",
    inputMint: request.inputMint, outputMint: request.outputMint, amountIn: request.amountIn,
    estimatedAmountOut: quote.estimatedAmountOut, minAmountOut, deadlineMs,
    hops: [{ kind: "propamm", inputMint: request.inputMint, outputMint: request.outputMint,
      amountIn: request.amountIn, estimatedAmountOut: quote.estimatedAmountOut }],
    transaction, rfq: { quoteId: quote.quoteId },
  };
}

/** Preserve the direct sell contract; direct buys retain their treasury validator. */
export function normalizeDirectRfqSell(request: QuoteExactInRequest, quote: DirectRfqQuote, market: DirectRfqMarket = MAINNET_AETH_USD): ServerTransactionSwapQuote {
  if (request.inputMint !== market.baseMint || request.outputMint !== market.quoteMint) {
    throw new RouterSdkError("UNSUPPORTED_PAIR", "Direct sells require mainnet aETH → aUSD.");
  }
  return normalizeNativeSwap(request, quote, market);
}

/** Resolve the one returned packet; legacy treasury quotes authorize nominal input only. */
export function composableDirectRfqSwap(request: QuoteExactInRequest, quote: DirectRfqQuote, market: DirectRfqMarket = MAINNET_AETH_USD): PropAmmQuote | TreasuryMintQuote {
  if (request.inputMint === market.quoteMint && request.outputMint === market.baseMint
    && quote?.transaction?.message?.instructions?.length === 2) {
    const { amountOut, issuanceId } = decodeTreasuryTemplate(request, quote, market);
    const authorization = quote.treasuryAuthorization;
    let minInput = request.amountIn, maxInput = request.amountIn;
    if (authorization !== undefined) {
      requireRfq(authorization !== null && authorization.version === 1
        && positiveU64(authorization.minAmountIn) && positiveU64(authorization.maxAmountIn)
        && authorization.minAmountIn <= request.amountIn && authorization.maxAmountIn >= request.amountIn,
      "Invalid treasury authorization version or input bounds.");
      minInput = authorization.minAmountIn;
      maxInput = authorization.maxAmountIn;
      requireRfq(minInput * amountOut / request.amountIn > 0n
        && maxInput * amountOut / request.amountIn <= U64_MAX, "Treasury range produces a zero or overflowing mint.");
    }
    // The native program expires at the start of the expiry second. Do not
    // advertise the last partial second as time available for wallet signing.
    const expiryBoundary = quote.expiresAtMs / 1000n * 1000n;
    if (expiryBoundary <= BigInt(Date.now())) throw new RouterSdkError("RFQ_EXPIRED", "Treasury quote has reached its execution expiry.");
    return {
      kind: "treasuryMint", quoteId: quote.quoteId, estimatedAmountOut: amountOut,
      terms: { issuanceId, quotedInput: request.amountIn, quotedOutput: amountOut,
        minInput, maxInput, expiryMs: quote.expiresAtMs },
    };
  }
  requireRfq(quote?.treasuryAuthorization === undefined, "Native swaps cannot carry treasury authorization.");
  normalizeNativeSwap(request, quote, market);
  const data = quote.transaction.message.instructions[0]!.data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    quoteId: quote.quoteId, quoteSigner: market.quoteSigner, estimatedAmountOut: quote.estimatedAmountOut,
    terms: {
      side: data[1] === 0 ? "buy" : "sell", baseAmount: view.getBigUint64(2, true), quoteAmount: view.getBigUint64(10, true),
      expiryMs: view.getBigUint64(18, true), nonce: view.getBigUint64(26, true),
    },
  };
}

export { normalizeDirectRfqBuy as normalizeAethUsdBuy, normalizeDirectRfqSell as normalizeAethUsdSell };

export { composableDirectRfqSwap as composableAethSwap };
