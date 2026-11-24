import {
  MAX_ACCOUNTS_PER_TRANSACTION, MAX_INSTRUCTION_COUNT_PER_TRANSACTION, MAX_SIGNERS,
  RUNTIME_TX_SIZE_LIMIT, RUNTIME_TX_VERSION, TransactionUtil, type RuntimeTransaction,
} from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { U64_MAX } from "./integers.js";
import { SwapSdkError } from "./swap-errors.js";
import type {
  NativeSwapQuote, SwapAttempt, SwapCandidateFailure, SwapPairs, SwapQuoteRequest,
  SwapRemainder, SwapRequiredSigner, SwapRouteLeg, SwapSubmitResult, SwapToken,
} from "./swap-types.js";

export function invalid(message: string): never {
  throw new SwapSdkError("INVALID_RESPONSE", message);
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected a JSON object.");
  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid("Expected a JSON array.");
  return Array.from(value);
}

export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("Expected a nonempty string.");
  return value;
}

export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    invalid("Expected a nonnegative integer within range.");
  }
  return value;
}

export function amount(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]{1,20}$/.test(value)) invalid("Expected a decimal u64 string.");
  const result = BigInt(value);
  if (result > U64_MAX) invalid("Amount exceeds u64.");
  return result;
}

export function address(value: unknown): string {
  const result = text(value);
  try {
    if (result.length > 44 || base58.decode(result).length !== 32) invalid("Expected a base58 public key.");
  } catch (cause) {
    throw new SwapSdkError("INVALID_RESPONSE", "Expected a base58 public key.", { cause });
  }
  return result;
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid("Expected a 64-character lowercase hex identifier.");
  return value;
}

function bytes(value: unknown, length?: number): Uint8Array {
  const values = value instanceof Uint8Array ? Array.from(value) : list(value);
  if (length !== undefined && values.length !== length) invalid("Invalid byte-array length.");
  return Uint8Array.from(values.map(value => integer(value, 255)));
}

export function decodeTransaction(value: unknown): RuntimeTransaction {
  const tx = record(value), message = record(tx.message), header = record(message.header);
  const keys = list(message.account_keys).map(value => bytes(value, 32));
  const required = integer(header.num_required_signatures, MAX_SIGNERS);
  const readonlySigned = integer(header.num_readonly_signed_accounts, required);
  const readonlyUnsigned = integer(header.num_readonly_unsigned_accounts, keys.length);
  const signatures = list(tx.signatures).map(value => bytes(value, 64));
  if (tx.version !== RUNTIME_TX_VERSION || required < 1 || required > keys.length
    || readonlySigned >= required || readonlyUnsigned > keys.length - required
    || keys.length > MAX_ACCOUNTS_PER_TRANSACTION || signatures.length !== required
    || new Set(keys.map(key => base58.encode(key))).size !== keys.length) {
    invalid("Invalid transaction version, accounts, header, or signature slots.");
  }
  const instructions = list(message.instructions).map(value => {
    const ix = record(value);
    return {
      program_id_index: integer(ix.program_id_index, keys.length - 1),
      accounts: list(ix.accounts).map(value => integer(value, keys.length - 1)),
      data: bytes(ix.data),
    };
  });
  if (!instructions.length || instructions.length > MAX_INSTRUCTION_COUNT_PER_TRANSACTION) invalid("Invalid instruction count.");
  const result: RuntimeTransaction = {
    version: RUNTIME_TX_VERSION, signatures,
    message: {
      header: {
        num_required_signatures: required, num_readonly_signed_accounts: readonlySigned,
        num_readonly_unsigned_accounts: readonlyUnsigned,
      },
      account_keys: keys, recent_blockhash: bytes(message.recent_blockhash, 32), instructions,
    },
  };
  if (TransactionUtil.serializedSize(result) > RUNTIME_TX_SIZE_LIMIT) invalid("Transaction exceeds the runtime size limit.");
  return result;
}

function token(value: unknown): SwapToken {
  const wire = record(value);
  return { mint: address(wire.mint), symbol: text(wire.symbol), decimals: integer(wire.decimals, 0xffff_ffff) };
}

function pair(value: unknown) {
  const wire = record(value);
  const result = { inputMint: address(wire.input_mint), outputMint: address(wire.output_mint) };
  if (result.inputMint === result.outputMint) invalid("A swap pair must have distinct mints.");
  return result;
}

export function decodePairs(value: unknown): SwapPairs {
  const wire = record(value), tokens = list(wire.tokens).map(token), pairs = list(wire.pairs).map(pair);
  const mints = new Set(tokens.map(token => token.mint));
  if (mints.size !== tokens.length || pairs.some(pair => !mints.has(pair.inputMint) || !mints.has(pair.outputMint))) {
    invalid("Discovery pairs and tokens disagree.");
  }
  return { tokens, pairs };
}

function remainder(value: unknown): SwapRemainder {
  const wire = record(value);
  const result = { ...token(wire), estimatedAmount: amount(wire.estimated_amount), minimumAmount: amount(wire.minimum_amount) };
  if (result.minimumAmount > result.estimatedAmount) invalid("Invalid remainder bounds.");
  return result;
}

function leg(value: unknown): SwapRouteLeg {
  const wire = record(value);
  const common = {
    ...pair(wire), estimatedAmountIn: amount(wire.estimated_amount_in),
    maxAmountIn: amount(wire.max_amount_in), amountOut: amount(wire.amount_out), programId: address(wire.program_id),
  };
  if (!common.estimatedAmountIn || !common.amountOut || common.estimatedAmountIn > common.maxAmountIn) invalid("Invalid leg amounts.");
  if (wire.venue === "treasury" && (wire.side === "buy" || wire.side === "sell")) {
    return { ...common, venue: "treasury", side: wire.side };
  }
  if (wire.venue === "clamm" && typeof wire.a_to_b === "boolean") {
    return { ...common, venue: "clamm", pool: address(wire.pool), aToB: wire.a_to_b };
  }
  return invalid("Unknown route venue or missing venue metadata.");
}

function signer(value: unknown): SwapRequiredSigner {
  const wire = record(value);
  if (wire.role !== "user" && wire.role !== "treasury") invalid("Unknown signer role.");
  return { index: integer(wire.index, MAX_SIGNERS - 1), pubkey: address(wire.pubkey), role: wire.role };
}

export function decodeQuote(value: unknown, request: SwapQuoteRequest): NativeSwapQuote {
  const wire = record(value);
  const quote: NativeSwapQuote = {
    ...pair(wire), quoteId: identifier(wire.quote_id), expiresAtMs: integer(wire.expires_at_ms),
    inputBudget: amount(wire.input_budget), estimatedAmountIn: amount(wire.estimated_amount_in),
    maxAmountIn: amount(wire.max_amount_in), guaranteedAmountOut: amount(wire.guaranteed_amount_out),
    unusedInput: remainder(wire.unused_input), intermediateLeftovers: list(wire.intermediate_leftovers).map(remainder),
    route: list(wire.route).map(leg), requiredSigners: list(wire.required_signers).map(signer),
    serializedSize: integer(wire.serialized_size, RUNTIME_TX_SIZE_LIMIT), transaction: decodeTransaction(wire.transaction),
  };
  if (quote.inputMint !== request.inputMint || quote.outputMint !== request.outputMint
    || quote.inputBudget !== request.maxAmountIn || !quote.estimatedAmountIn || !quote.guaranteedAmountOut
    || quote.estimatedAmountIn > quote.maxAmountIn || quote.maxAmountIn > quote.inputBudget
    || quote.unusedInput.mint !== quote.inputMint || quote.serializedSize !== TransactionUtil.serializedSize(quote.transaction)) {
    invalid("Quote does not match the requested pair, budget, or packet size.");
  }
  const users = quote.requiredSigners.filter(signer => signer.role === "user");
  if (users.length !== 1 || users[0]!.pubkey !== request.user
    || quote.requiredSigners.length !== quote.transaction.signatures.length
    || quote.requiredSigners.some((signer, index) => signer.index !== index
      || signer.pubkey !== base58.encode(quote.transaction.message.account_keys[index]!))
    || quote.transaction.signatures.some(signature => signature.some(byte => byte !== 0))) {
    invalid("Quote signer metadata does not match its unsigned packet or requested user.");
  }
  const first = quote.route[0], last = quote.route.at(-1);
  if (!first || !last || first.inputMint !== quote.inputMint || last.outputMint !== quote.outputMint
    || first.estimatedAmountIn !== quote.estimatedAmountIn || first.maxAmountIn !== quote.maxAmountIn
    || last.amountOut !== quote.guaranteedAmountOut || quote.intermediateLeftovers.length !== quote.route.length - 1
    || quote.route.slice(1).some((leg, index) => leg.inputMint !== quote.route[index]!.outputMint
      || leg.maxAmountIn > quote.route[index]!.amountOut
      || quote.intermediateLeftovers[index]!.mint !== leg.inputMint)) invalid("Quote route metadata is inconsistent.");
  if (quote.unusedInput.estimatedAmount !== quote.inputBudget - first.estimatedAmountIn
    || quote.unusedInput.minimumAmount !== quote.inputBudget - first.maxAmountIn
    || quote.intermediateLeftovers.some((remainder, index) => {
      const available = quote.route[index]!.amountOut, next = quote.route[index + 1]!;
      return remainder.estimatedAmount !== available - next.estimatedAmountIn
        || remainder.minimumAmount !== available - next.maxAmountIn;
    })) invalid("Quote remainder amounts disagree with its route and input budget.");
  return quote;
}

export function decodeSubmit(value: unknown): SwapSubmitResult {
  return { transactionHash: identifier(record(value).transaction_hash) };
}

export function decodeAttempt(value: unknown, quoteId: string): SwapAttempt {
  const wire = record(value), outcome = wire.outcome;
  if (identifier(wire.quote_id) !== quoteId) invalid("Attempt quote ID does not match.");
  if (outcome !== "submitting" && outcome !== "accepted" && outcome !== "rejected" && outcome !== "unknown") invalid("Unknown attempt outcome.");
  return {
    ...decodeSubmit(wire), quoteId, outcome,
    attemptedAtMs: integer(wire.attempted_at_ms), expiresAtMs: integer(wire.expires_at_ms),
  };
}

export function decodeApiError(value: unknown, status: number, submitting: boolean): SwapSdkError {
  const wire = record(value), code = text(wire.code);
  const failures: SwapCandidateFailure[] = wire.failures === undefined ? [] : list(wire.failures).map(value => {
    const failure = record(value);
    const cap = failure.cap === undefined ? undefined : record(failure.cap);
    if (cap && cap.kind !== "input" && cap.kind !== "payout") invalid("Unknown cap kind.");
    return {
      code: text(failure.code), error: text(failure.error), route: list(failure.route).map(address),
      ...(failure.leg_index === undefined ? {} : { legIndex: integer(failure.leg_index) }),
      ...(cap ? { cap: { kind: cap.kind as "input" | "payout", mint: address(cap.mint), amount: amount(cap.amount), limit: amount(cap.limit) } } : {}),
    };
  });
  return new SwapSdkError(code, text(wire.error), {
    status, failures,
    ...(wire.transaction_hash === undefined ? {} : { transactionHash: identifier(wire.transaction_hash) }),
    submissionUncertain: submitting && (status >= 500 || status === 409 || code === "native_quote_not_found"),
  });
}
