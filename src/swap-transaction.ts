import { SanitizedMessageUtil, TransactionUtil, bytesEqual, type RuntimeTransaction } from "@arch-network/arch-sdk";
import { decodeTransaction } from "./swap-codec.js";
import { SwapSdkError } from "./swap-errors.js";
import type { NativeSwapQuote } from "./swap-types.js";

interface Snapshot {
  readonly service: string;
  readonly quoteId: string;
  readonly expiresAtMs: number;
  readonly userIndex: number;
  readonly transaction: RuntimeTransaction;
  readonly message: Uint8Array;
  readonly clock: () => number;
  readonly serialized: string;
}

const snapshots = new WeakMap<NativeSwapQuote, Snapshot>();

/** Internal registration keeps trusted bytes separate from the mutable wallet packet. */
export function rememberQuote(quote: NativeSwapQuote, service: string, clock: () => number, serialized: string): NativeSwapQuote {
  const transaction = decodeTransaction(quote.transaction);
  const snapshot = {
    service, quoteId: quote.quoteId, expiresAtMs: quote.expiresAtMs,
    userIndex: quote.requiredSigners.find(signer => signer.role === "user")!.index,
    transaction, message: SanitizedMessageUtil.serialize(transaction.message), clock, serialized,
  };
  snapshots.set(quote, snapshot);
  requireLive(snapshot);
  return quote;
}

function requireLive(snapshot: Snapshot): void {
  if (snapshot.clock() >= snapshot.expiresAtMs) throw new SwapSdkError("QUOTE_EXPIRED", "Get a fresh quote before signing or submitting.");
}

function sameMessage(snapshot: Snapshot, transaction: RuntimeTransaction): void {
  if (transaction.version !== snapshot.transaction.version
    || !bytesEqual(SanitizedMessageUtil.serialize(transaction.message), snapshot.message)) {
    throw new SwapSdkError("MESSAGE_CHANGED", "The quoted transaction message or version was changed.");
  }
}

function snapshotFor(quote: NativeSwapQuote, service?: string): Snapshot {
  const snapshot = snapshots.get(quote);
  if (!snapshot) throw new SwapSdkError("UNKNOWN_QUOTE", "Use the original quote object returned by this SDK.");
  if (service !== undefined && service !== snapshot.service) throw new SwapSdkError("INVALID_REQUEST", "Quote belongs to a different service URL.");
  requireLive(snapshot);
  if (quote.quoteId !== snapshot.quoteId || quote.expiresAtMs !== snapshot.expiresAtMs) {
    throw new SwapSdkError("MESSAGE_CHANGED", "Quote ID or expiry metadata was changed.");
  }
  try { sameMessage(snapshot, decodeTransaction(quote.transaction)); }
  catch (cause) {
    if (cause instanceof SwapSdkError && cause.code === "MESSAGE_CHANGED") throw cause;
    throw new SwapSdkError("MESSAGE_CHANGED", "The original quoted packet is malformed or changed.", { cause });
  }
  return snapshot;
}

/** The app signs the original message; only its 64-byte user signature is attached. */
export function attachUserSignature(quote: NativeSwapQuote, signature: Uint8Array): RuntimeTransaction {
  const snapshot = snapshotFor(quote);
  if (!(signature instanceof Uint8Array) || signature.length !== 64 || signature.every(byte => byte === 0)) {
    throw new SwapSdkError("INVALID_SIGNATURE", "Expected a nonzero 64-byte user signature.");
  }
  const transaction = decodeTransaction(snapshot.transaction);
  transaction.signatures[snapshot.userIndex] = signature.slice();
  return transaction;
}

/** Opaque JSON-safe flow state; contains the unsigned packet and no wallet signature. */
export function serializeSwapQuote(quote: NativeSwapQuote): string {
  return snapshotFor(quote).serialized;
}

/** Validate and copy synchronously, before any await can expose a mutable packet. */
export function submissionBody(quote: NativeSwapQuote, value: RuntimeTransaction, service: string): string {
  const snapshot = snapshotFor(quote, service);
  let transaction: RuntimeTransaction;
  try { transaction = decodeTransaction(value); }
  catch (cause) { throw new SwapSdkError("INVALID_TRANSACTION", "Malformed signed transaction.", { cause }); }
  sameMessage(snapshot, transaction);
  if (transaction.signatures.some((signature, index) => index === snapshot.userIndex
    ? signature.every(byte => byte === 0) : signature.some(byte => byte !== 0))) {
    throw new SwapSdkError("INVALID_SIGNATURE", "Only the user signature slot may be populated; treasury slots must be zero.");
  }
  return JSON.stringify({ quote_id: snapshot.quoteId, transaction: TransactionUtil.toNumberArray(transaction) });
}
