import { base58ToBytes, bytesToHex, TransactionUtil } from "@arch-network/arch-sdk";
import {
  createRouterClient, MAINNET_AETH_USD as market, RouterSdkError,
  type DirectRfqQuoteProvider, type QuoteExactInRequest, type RouterDataSource,
  type RuntimeTransaction, type ServerTransactionSwapQuote,
} from "../src/index.js";

export interface AethUsdExampleOptions {
  readonly serverUrl: string;
  readonly source: RouterDataSource;
  /** POST application/json; reject non-2xx responses and return the raw response text. */
  readonly post: (url: string, body: string) => Promise<string>;
  /** Use the wallet's Arch signing flow; return only the user's 64-byte signature. */
  readonly signMessage: (message: RuntimeTransaction["message"]) => Promise<Uint8Array>;
  /** Resolve on confirmed success; reject on execution failure or uncertain confirmation. */
  readonly confirm: (transactionHash: string) => Promise<void>;
}

export interface PreparedAethUsdSwap {
  readonly quote: ServerTransactionSwapQuote;
  /** Explicit retries reuse the signed body; a known hash only needs confirmation. */
  submitAndConfirm(): Promise<string>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouterSdkError("INVALID_RFQ", "Expected an RFQ JSON object.");
  }
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new RouterSdkError("INVALID_RFQ", "Expected an RFQ array.");
  return value;
}

function byte(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new RouterSdkError("INVALID_RFQ", "Invalid RFQ byte or account index.");
  }
  return value;
}

function bytes(value: unknown, length?: number): Uint8Array {
  const result = Uint8Array.from(list(value).map(byte));
  if (length !== undefined && result.length !== length) throw new RouterSdkError("INVALID_RFQ", "Invalid RFQ byte-array length.");
  return result;
}

function safeU64(value: unknown): bigint {
  // JSON.parse cannot recover large numeric literals. Reject them before conversion.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RouterSdkError("INVALID_RFQ", "RFQ amount/expiry must be a safe integer; larger values need a lossless JSON decoder.");
  }
  return BigInt(value);
}

function decodeQuote(raw: string, buy: boolean) {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (cause) { throw new RouterSdkError("INVALID_RFQ", "Malformed RFQ JSON.", { cause }); }
  const wire = record(parsed), message = record(wire.message), header = record(message.header);
  const estimate = record(wire.estimated_quote);
  if (typeof wire.quote_id !== "string") throw new RouterSdkError("INVALID_RFQ", "Missing RFQ quote ID.");
  const transaction: RuntimeTransaction = {
    version: byte(wire.version), signatures: list(wire.signatures).map(value => bytes(value, 64)),
    message: {
      header: {
        num_required_signatures: byte(header.num_required_signatures),
        num_readonly_signed_accounts: byte(header.num_readonly_signed_accounts),
        num_readonly_unsigned_accounts: byte(header.num_readonly_unsigned_accounts),
      },
      account_keys: list(message.account_keys).map(value => bytes(value, 32)),
      recent_blockhash: bytes(message.recent_blockhash, 32),
      instructions: list(message.instructions).map(value => {
        const instruction = record(value);
        return { program_id_index: byte(instruction.program_id_index),
          accounts: list(instruction.accounts).map(byte), data: bytes(instruction.data) };
      }),
    },
  };
  return { transaction, quoteId: wire.quote_id, expiresAtMs: safeU64(wire.expires_at_ms),
    estimatedAmountOut: safeU64(buy ? estimate.base_amount : estimate.quote_amount) };
}

/** Quote first so the caller can review the amount before invoking the wallet. */
export async function prepareAethUsdSwap(options: AethUsdExampleOptions, request: QuoteExactInRequest): Promise<PreparedAethUsdSwap> {
  const buy = request.inputMint === market.quoteMint && request.outputMint === market.baseMint;
  const sell = request.inputMint === market.baseMint && request.outputMint === market.quoteMint;
  if (!buy && !sell) throw new RouterSdkError("UNSUPPORTED_PAIR", "This example supports only mainnet aUSD ↔ aETH.");
  const { post, signMessage, confirm } = options;
  const serverUrl = options.serverUrl.replace(/\/+$/, "");
  const provider: DirectRfqQuoteProvider = {
    async quoteExactIn(input) {
      // Encode the u64 amount as a JSON numeric literal without a Number conversion.
      // All interpolated strings below are hex or fixed literals, and the SDK has
      // already validated the amount, user and slippage before invoking this provider.
      const body = `{"base_mint":"${bytesToHex(base58ToBytes(market.baseMint))}",`
        + `"quote_mint":"${bytesToHex(base58ToBytes(market.quoteMint))}","side":"${buy ? "buy" : "sell"}",`
        + `"amount":${input.amountIn.toString()},"user_pubkey":"${bytesToHex(base58ToBytes(input.user))}",`
        + `"slippage_bps":${input.slippageBps}}`;
      return decodeQuote(await post(`${serverUrl}/rfq/quote`, body), buy);
    },
  };
  const router = createRouterClient({ network: "mainnet", source: options.source, directRfqQuoteProvider: provider });
  const quote = await router.quoteExactIn(request);
  if (quote.execution !== "serverTransaction") throw new RouterSdkError("INVALID_RFQ", "Expected a direct server transaction.");
  const { transaction, deadlineMs, rfq: { quoteId } } = quote;
  const originalBytes = bytesToHex(TransactionUtil.serialize(transaction));
  let body: string | undefined;
  let transactionHash: string | undefined;
  let inFlight: Promise<string> | undefined;

  function requireFresh(): void {
    if (Date.now() >= deadlineMs) throw new RouterSdkError("RFQ_EXPIRED", "Get a fresh quote before signing or submitting.");
  }
  function requireUnchanged(): void {
    if (bytesToHex(TransactionUtil.serialize(transaction)) !== originalBytes) {
      throw new RouterSdkError("MESSAGE_CHANGED", "The original RFQ transaction was modified.");
    }
  }
  async function submit(): Promise<string> {
    if (transactionHash === undefined) {
      requireFresh();
      if (body === undefined) {
        requireUnchanged();
        const signature = await signMessage(transaction.message);
        requireUnchanged();
        if (!(signature instanceof Uint8Array) || signature.length !== 64) {
          throw new RouterSdkError("INVALID_SIGNATURE", "The wallet must return the user's 64-byte Arch signature.");
        }
        // Freeze the exact wire body once. Retries cannot pick up later mutations.
        body = JSON.stringify({ quote_id: quoteId, ...TransactionUtil.toNumberArray({ ...transaction, signatures: [signature] }) });
      }
      requireFresh();
      const response: unknown = JSON.parse(await post(`${serverUrl}/rfq/swap`, body));
      if (!response || typeof response !== "object" || !("transaction_hash" in response)
        || typeof response.transaction_hash !== "string" || !response.transaction_hash.trim()) {
        throw new RouterSdkError("INVALID_SUBMISSION_RESPONSE", "RFQ server did not return a transaction hash.");
      }
      transactionHash = response.transaction_hash;
    }
    // A known transaction can still be confirmed after the quote deadline.
    await confirm(transactionHash);
    return transactionHash;
  }
  return { quote, submitAndConfirm() {
    if (!inFlight) inFlight = submit().finally(() => { inFlight = undefined; });
    return inFlight;
  } };
}
