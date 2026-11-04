import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import {
  compileRouterMessage, createRouterClient, MAINNET_AETH_USD as market, MAINNET_RFQ_DEPLOYMENT, RouterSdkError,
  type DirectRfqQuoteProvider, type QuoteExactInRequest, type RouterDataSource, type TreasuryAuthorization,
  type RuntimeTransaction, type RouterSwapQuote,
} from "../src/index.js";

export interface AethUsdExampleOptions {
  readonly serverUrl: string;
  readonly source: RouterDataSource;
  /** POST application/json; reject non-2xx responses and return the raw response text. */
  readonly post: (url: string, body: string) => Promise<string>;
  /** Fetch a fresh 32-byte Arch blockhash for compiling the router transaction. */
  readonly getRecentBlockhash: () => Promise<Uint8Array>;
  /** Use the wallet's Arch signing flow; return only the user's 64-byte signature. */
  readonly signMessage: (message: RuntimeTransaction["message"]) => Promise<Uint8Array>;
  /** Resolve on confirmed success; reject on execution failure or uncertain confirmation. */
  readonly confirm: (transactionHash: string) => Promise<void>;
}

export interface PreparedAethUsdSwap {
  readonly quote: RouterSwapQuote;
  readonly transaction: RuntimeTransaction;
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

function authorizationAmount(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) {
    throw new RouterSdkError("INVALID_RFQ", "Treasury authorization amounts must be decimal u64 strings.");
  }
  const amount = BigInt(value);
  if (amount === 0n || amount > (1n << 64n) - 1n) {
    throw new RouterSdkError("INVALID_RFQ", "Treasury authorization amount is outside the positive u64 range.");
  }
  return amount;
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
  let expiresAtMs: bigint;
  if (buy && transaction.message.instructions.length === 2) {
    expiresAtMs = safeU64(wire.expires_at_ms);
  } else {
    // Native swap responses need no redundant expiry metadata. Read the exact
    // u64 from the trade; the SDK still validates the complete native packet.
    const trade = transaction.message.instructions[0];
    const program = trade && transaction.message.account_keys[trade.program_id_index];
    if (transaction.message.instructions.length !== 1 || !trade || !program
      || base58.encode(program) !== market.programId || trade.data.length !== 50
      || trade.data[0] !== 2 || trade.data[1] !== (buy ? 0 : 1)) {
      throw new RouterSdkError("INVALID_RFQ", "Expected a native aETH swap with an explicit minimum output.");
    }
    expiresAtMs = new DataView(trade.data.buffer, trade.data.byteOffset, trade.data.byteLength).getBigUint64(18, true);
    if (wire.expires_at_ms !== undefined && safeU64(wire.expires_at_ms) !== expiresAtMs) {
      throw new RouterSdkError("INVALID_RFQ", "RFQ expiry metadata differs from the native swap.");
    }
  }
  let treasuryAuthorization: TreasuryAuthorization | undefined;
  if (wire.treasury_authorization !== undefined) {
    const authorization = record(wire.treasury_authorization);
    if (!buy || transaction.message.instructions.length !== 2 || authorization.version !== 1) {
      throw new RouterSdkError("INVALID_RFQ", "Unexpected treasury authorization or version.");
    }
    treasuryAuthorization = { version: 1,
      minAmountIn: authorizationAmount(authorization.min_amount_in),
      maxAmountIn: authorizationAmount(authorization.max_amount_in) };
  }
  return { transaction, quoteId: wire.quote_id, expiresAtMs,
    ...(treasuryAuthorization === undefined ? {} : { treasuryAuthorization }),
    estimatedAmountOut: safeU64(buy ? estimate.base_amount : estimate.quote_amount) };
}

/** Quote-only HTTP provider; rfqUrl includes /rfq, without /quote. */
export function createAethUsdRfqProvider(rfqUrl: string, post: AethUsdExampleOptions["post"]): DirectRfqQuoteProvider {
  const url = `${rfqUrl.replace(/\/+$/, "")}/quote`;
  return {
    async quoteExactIn(input) {
      const buy = input.inputMint === market.quoteMint && input.outputMint === market.baseMint;
      const sell = input.inputMint === market.baseMint && input.outputMint === market.quoteMint;
      if (!buy && !sell) throw new RouterSdkError("UNSUPPORTED_PAIR", "This example supports only mainnet aUSD ↔ aETH.");
      // Encode the u64 amount as a JSON numeric literal without a Number conversion.
      // All interpolated strings below are hex or fixed literals, and the SDK has
      // already validated the amount, user and slippage before invoking this provider.
      const body = `{"base_mint":"${hex.encode(base58.decode(market.baseMint))}",`
        + `"quote_mint":"${hex.encode(base58.decode(market.quoteMint))}","side":"${buy ? "buy" : "sell"}",`
        + `"amount":${input.amountIn.toString()},"user_pubkey":"${hex.encode(base58.decode(input.user))}",`
        + `"slippage_bps":${input.slippageBps}}`;
      return decodeQuote(await post(url, body), buy);
    },
  };
}

/** Quote first so the caller can review the amount before invoking the wallet. */
export async function prepareAethUsdSwap(options: AethUsdExampleOptions, request: QuoteExactInRequest): Promise<PreparedAethUsdSwap> {
  const input = { ...request };
  const buy = input.inputMint === market.quoteMint && input.outputMint === market.baseMint;
  const sell = input.inputMint === market.baseMint && input.outputMint === market.quoteMint;
  if (!buy && !sell) throw new RouterSdkError("UNSUPPORTED_PAIR", "This example supports only mainnet aUSD ↔ aETH.");
  const { post, signMessage, confirm, getRecentBlockhash } = options;
  const serverUrl = options.serverUrl.replace(/\/+$/, "");
  const provider = createAethUsdRfqProvider(`${serverUrl}/rfq`, post);
  const router = createRouterClient({ network: "mainnet", source: options.source, directRfqQuoteProvider: provider, directRfqDeployment: MAINNET_RFQ_DEPLOYMENT, directRfqMarkets: [market] });
  const quote = await router.quoteExactIn(input);
  const { deadlineMs, rfq } = quote;
  if (!rfq) throw new RouterSdkError("INVALID_RFQ", "Expected an aETH RFQ.");
  const quoteId = rfq.quoteId;
  const blockhash = await getRecentBlockhash();
  if (!(blockhash instanceof Uint8Array) || blockhash.length !== 32) {
    throw new RouterSdkError("INVALID_RESPONSE", "Expected a 32-byte Arch blockhash.");
  }
  requireFresh();
  const transaction: RuntimeTransaction = {
    version: 0, signatures: [], message: compileRouterMessage(quote.instructions, input.user, blockhash),
  };
  const originalBytes = hex.encode(TransactionUtil.serialize(transaction));
  let body: string | undefined;
  let transactionHash: string | undefined;
  let inFlight: Promise<string> | undefined;

  function requireFresh(): void {
    if (Date.now() >= deadlineMs) throw new RouterSdkError("RFQ_EXPIRED", "Get a fresh quote before signing or submitting.");
  }
  function requireUnchanged(): void {
    if (hex.encode(TransactionUtil.serialize(transaction)) !== originalBytes) {
      throw new RouterSdkError("MESSAGE_CHANGED", "The prepared router transaction was modified.");
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
  return { quote, transaction, submitAndConfirm() {
    if (!inFlight) inFlight = submit().finally(() => { inFlight = undefined; });
    return inFlight;
  } };
}
