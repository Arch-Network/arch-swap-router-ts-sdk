import { base58 } from "@scure/base";
import type { DirectRfqMarketDeployment } from "./config/direct-rfq-markets.js";
import { RouterSdkError } from "./errors.js";
import type { DirectRfqQuote, PropAmmQuote, QuoteExactInRequest, ServerTransactionSwapQuote } from "./types.js";
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

function userAta(user: Uint8Array, mint: string, market: DirectRfqMarketDeployment): string {
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

/** Validate the canonical treasury payment/mint packet; the router re-encodes its terms. */
export function decodeTreasuryTemplate(request: QuoteExactInRequest, quote: DirectRfqQuote, market: DirectRfqMarketDeployment) {
  if (request.inputMint !== market.quoteMint || request.outputMint !== market.baseMint) {
    throw new RouterSdkError("UNSUPPORTED_PAIR", "Treasury buys require the configured quote → base mint pair.");
  }
  const { treasuryAuthority, bridgeProgramId } = market;
  if (treasuryAuthority === undefined || bridgeProgramId === undefined) {
    throw new RouterSdkError("INVALID_RFQ", "Treasury execution is not configured for this market.");
  }
  const { user, deadlineMs, transaction, message, header, keys } = readDirectRfq(request, quote, treasuryAuthority, 2);
  const payment = message.instructions[0]!;
  const mint = message.instructions[1]!;
  requireRfq(keys[payment.program_id_index] === market.tokenProgramId && payment.accounts.length === 3
    && bytes(payment.data, 9) && payment.data[0] === 3, "Expected the canonical aUSD transfer.");
  requireRfq(keys[mint.program_id_index] === bridgeProgramId && mint.accounts.length === 11
    && bytes(mint.data, 73) && mint.data[0] === 21, "Expected the canonical treasury mint.");
  const paymentData = new DataView(payment.data.buffer, payment.data.byteOffset, payment.data.byteLength);
  const mintData = new DataView(mint.data.buffer, mint.data.byteOffset, mint.data.byteLength);
  const amountOut = mintData.getBigUint64(33, true);
  requireRfq(paymentData.getBigUint64(1, true) === request.amountIn, "Payment differs from the requested input.");
  requireRfq(amountOut > 0n && amountOut === quote.estimatedAmountOut, "Mint payout differs from the quoted output.");
  requireRfq(base58.encode(mint.data.subarray(41)) === request.user, "Mint data names another recipient.");

  const paymentKeys = [userAta(user, market.quoteMint, market), market.quoteVault, request.user];
  const mintKeys = [
    treasuryAuthority,
    deriveAddress(bridgeProgramId, "config"),
    deriveAddress(bridgeProgramId, "asset", decodeAddress(market.baseMint)),
    deriveAddress(bridgeProgramId, "treasury_mint", mint.data.subarray(1, 33)),
    market.baseMint,
    deriveAddress(bridgeProgramId, "mint-authority", decodeAddress(market.baseMint)),
    request.user, userAta(user, market.baseMint, market), market.tokenProgramId,
    market.associatedTokenProgramId, market.systemProgramId,
  ];
  requireRfq(payment.accounts.every((index, i) => keys[index] === paymentKeys[i])
    && mint.accounts.every((index, i) => keys[index] === mintKeys[i]), "Unexpected payment or mint accounts.");
  validateAccounts(keys, header.num_readonly_unsigned_accounts,
    [...paymentKeys, ...mintKeys, market.tokenProgramId, bridgeProgramId],
    [request.user, treasuryAuthority, paymentKeys[0]!, market.quoteVault, mintKeys[3]!, market.baseMint, mintKeys[7]!]);
  if (deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Treasury-buy quote deadline has expired.");

  return { transaction, deadlineMs, amountOut, issuanceId: mint.data.slice(1, 33) };
}

export interface BtcTreasuryRfqDeployment extends DirectRfqMarketDeployment {
  readonly btcTreasury: {
    readonly programId: string;
    readonly initialAdmin: string;
    readonly minter: string;
  };
}

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/** Validate and preserve the BTC buy packet for direct submission to the RFQ server. */
export function prepareBtcTreasuryBuy(
  request: QuoteExactInRequest, quote: DirectRfqQuote, market: BtcTreasuryRfqDeployment,
): ServerTransactionSwapQuote {
  if (request.inputMint !== market.quoteMint || request.outputMint !== market.baseMint) {
    throw new RouterSdkError("UNSUPPORTED_PAIR", "BTC treasury buys require the configured aUSD → aBTC pair.");
  }
  requireRfq(quote?.treasuryAuthorization === undefined, "Direct BTC buys cannot carry router authorization.");
  const { programId, initialAdmin, minter } = market.btcTreasury;
  const { user, deadlineMs, transaction, message, header, keys } = readDirectRfq(request, quote, minter, 6);
  const [heap, compute, createAta, payment, mint, payout] = message.instructions;
  const matches = (ix: typeof mint, program: string, accounts: readonly string[]) =>
    keys[ix!.program_id_index] === program && ix!.accounts.length === accounts.length
      && ix!.accounts.every((index, i) => keys[index] === accounts[i]);
  const budget = (ix: typeof mint, tag: number, value: number) =>
    matches(ix, COMPUTE_BUDGET, []) && bytes(ix!.data, 8)
      && new DataView(ix!.data.buffer, ix!.data.byteOffset, 8).getUint32(0, true) === tag
      && new DataView(ix!.data.buffer, ix!.data.byteOffset, 8).getUint32(4, true) === value;
  requireRfq(budget(heap, 0, 256 * 1024) && budget(compute, 1, 1_400_000), "Unexpected BTC mint compute budget.");
  requireRfq(bytes(mint!.data, 41) && mint!.data[0] === 8, "Unexpected BTC bridge mint data.");
  const config = deriveAddress(programId, "bridge", decodeAddress(market.baseMint), decodeAddress(initialAdmin));
  const credit = deriveAddress(programId, "treasury-credit", decodeAddress(config));
  const operation = deriveAddress(programId, "treasury-operation", decodeAddress(config), mint!.data.subarray(1, 33));
  const minterAta = userAta(decodeAddress(minter), market.baseMint, market);
  const outputAta = userAta(user, market.baseMint, market);
  const inputAta = userAta(user, market.quoteMint, market);
  const ataKeys = [request.user, outputAta, request.user, market.baseMint, market.systemProgramId, market.tokenProgramId];
  const paymentKeys = [inputAta, market.quoteVault, request.user];
  const mintKeys = [
    minter, config, credit, operation, market.baseMint, minterAta,
    market.tokenProgramId, market.associatedTokenProgramId, market.systemProgramId,
  ];
  const payoutKeys = [minterAta, outputAta, minter];
  const transfer = (ix: typeof mint, accounts: readonly string[], amount: bigint) =>
    matches(ix, market.tokenProgramId, accounts) && bytes(ix!.data, 9) && ix!.data[0] === 3
      && new DataView(ix!.data.buffer, ix!.data.byteOffset, 9).getBigUint64(1, true) === amount;
  const amountOut = new DataView(mint!.data.buffer, mint!.data.byteOffset, 41).getBigUint64(33, true);
  requireRfq(amountOut > 0n && amountOut === quote.estimatedAmountOut, "BTC mint differs from the quoted output.");
  requireRfq(matches(createAta, market.associatedTokenProgramId, ataKeys)
    && bytes(createAta!.data, 1) && createAta!.data[0] === 1, "Unexpected buyer aBTC account creation.");
  requireRfq(transfer(payment, paymentKeys, request.amountIn), "Unexpected aUSD payment.");
  requireRfq(matches(mint, programId, mintKeys), "Unexpected BTC treasury accounts.");
  requireRfq(transfer(payout, payoutKeys, amountOut), "Unexpected aBTC payout.");
  validateAccounts(keys, header.num_readonly_unsigned_accounts,
    [...ataKeys, ...paymentKeys, ...mintKeys, ...payoutKeys, programId, COMPUTE_BUDGET],
    [request.user, minter, inputAta, market.quoteVault, credit, operation, market.baseMint, minterAta, outputAta]);
  if (deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "BTC treasury quote deadline has expired.");
  return {
    execution: "serverTransaction", transaction, rfq: { quoteId: quote.quoteId }, deadlineMs,
    inputMint: request.inputMint, outputMint: request.outputMint, amountIn: request.amountIn,
    estimatedAmountOut: amountOut, minAmountOut: amountOut,
    hops: [{ kind: "treasuryMint", inputMint: request.inputMint, outputMint: request.outputMint,
      amountIn: request.amountIn, estimatedAmountOut: amountOut }],
  };
}

/** Validate a pinned native ExecuteTrade for either side; the router re-encodes its terms. */
export function decodeNativeSwap(request: QuoteExactInRequest, quote: DirectRfqQuote, market: DirectRfqMarketDeployment) {
  const buy = request.inputMint === market.quoteMint && request.outputMint === market.baseMint;
  const sell = request.inputMint === market.baseMint && request.outputMint === market.quoteMint;
  if (!buy && !sell) {
    throw new RouterSdkError("UNSUPPORTED_PAIR", "Native swaps require the configured base/quote mint pair.");
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

  const tradeKeys = [
    market.config, market.quoteSigner, request.user,
    deriveAddress(market.programId, "user_nonce", decodeAddress(market.config), user),
    market.baseVault, market.quoteVault, userAta(user, market.baseMint, market), userAta(user, market.quoteMint, market),
    market.baseMint, market.quoteMint, market.tokenProgramId, market.systemProgramId, market.associatedTokenProgramId,
  ];
  requireRfq(trade.accounts.every((index, i) => keys[index] === tradeKeys[i]), "Unexpected native swap accounts.");
  validateAccounts(keys, header.num_readonly_unsigned_accounts, [...tradeKeys, market.programId], tradeKeys.slice(0, 12));
  if (deadlineMs <= Date.now()) throw new RouterSdkError("RFQ_EXPIRED", "Native swap quote deadline has expired.");

  const terms: PropAmmQuote["terms"] = {
    side: buy ? "buy" : "sell", baseAmount: data.getBigUint64(2, true), quoteAmount: data.getBigUint64(10, true),
    expiryMs: data.getBigUint64(18, true), nonce: data.getBigUint64(26, true),
  };
  return { transaction, deadlineMs, estimatedAmountOut: quote.estimatedAmountOut, minAmountOut, terms };
}

/** Resolve the returned packet, preserving the server's required treasury authorization. */
export function composableDirectRfqSwap(request: QuoteExactInRequest, quote: DirectRfqQuote, market: DirectRfqMarketDeployment): PropAmmQuote | TreasuryMintQuote {
  if (request.inputMint === market.quoteMint && request.outputMint === market.baseMint
    && quote?.transaction?.message?.instructions?.length === 2) {
    const { amountOut, issuanceId } = decodeTreasuryTemplate(request, quote, market);
    const authorization = quote.treasuryAuthorization;
    if (authorization === undefined) {
      throw new RouterSdkError("INVALID_RFQ", "Treasury routing requires server-issued authorization.");
    }
    requireRfq(authorization !== null && authorization.version === 1
      && positiveU64(authorization.minAmountIn) && positiveU64(authorization.maxAmountIn)
      && authorization.minAmountIn <= request.amountIn && authorization.maxAmountIn >= request.amountIn,
    "Invalid treasury authorization version or input bounds.");
    const { minAmountIn: minInput, maxAmountIn: maxInput } = authorization;
    requireRfq(minInput * amountOut / request.amountIn > 0n
      && maxInput * amountOut / request.amountIn <= U64_MAX, "Treasury range produces a zero or overflowing mint.");
    // quotePropAmm clamps the route deadline to the start of the expiry second.
    return {
      kind: "treasuryMint", quoteId: quote.quoteId, estimatedAmountOut: amountOut,
      terms: { issuanceId, quotedInput: request.amountIn, quotedOutput: amountOut,
        minInput, maxInput, expiryMs: quote.expiresAtMs },
    };
  }
  requireRfq(quote?.treasuryAuthorization === undefined, "Native swaps cannot carry treasury authorization.");
  const { terms } = decodeNativeSwap(request, quote, market);
  return { quoteId: quote.quoteId, quoteSigner: market.quoteSigner, estimatedAmountOut: quote.estimatedAmountOut, terms };
}
