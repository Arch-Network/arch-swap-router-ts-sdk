import { base58, hex } from "@scure/base";
import { RouterSdkError, type PropAmmQuoteProvider } from "../../src/index.js";
import { NETWORKS } from "../../src/config/networks.js";

const deployment = NETWORKS.mainnet.propammMarkets[0]!;
const hexAddress = (address: string) => hex.encode(base58.decode(address));

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
  if (length !== undefined && result.length !== length) {
    throw new RouterSdkError("INVALID_RFQ", "Invalid RFQ byte-array length.");
  }
  return result;
}

function outputAmount(value: unknown): bigint {
  // JSON.parse cannot recover unsafe numeric literals; reject before conversion.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RouterSdkError("INVALID_RFQ", "RFQ output must be a positive safe integer; larger values need a lossless JSON decoder.");
  }
  return BigInt(value);
}

/** Test-only HTTP adapter for the fixed mainnet aBTC/aUSD RFQ market. */
export function createMainnetPropAmmRfqProvider(rfqUrl: string): PropAmmQuoteProvider {
  return {
    async quoteExactIn(request) {
      const buy = request.inputMint === deployment.quoteMint && request.outputMint === deployment.baseMint;
      const sell = request.inputMint === deployment.baseMint && request.outputMint === deployment.quoteMint;
      if (!buy && !sell) throw new RouterSdkError("UNSUPPORTED_PAIR", "RFQ smoke provider supports mainnet aBTC/aUSD only.");
      const side = buy ? "buy" : "sell";
      // Write the raw u64 as a JSON number without a potentially lossy Number cast.
      const body = `{"base_mint":"${hexAddress(deployment.baseMint)}",`
        + `"quote_mint":"${hexAddress(deployment.quoteMint)}","side":"${side}",`
        + `"amount":${request.amountIn.toString()},"user_pubkey":"${hexAddress(request.user)}"}`;
      const response = await fetch(`${rfqUrl.replace(/\/+$/, "")}/quote`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(1800), // Finish before the SDK's 2-second RFQ timeout.
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`RFQ HTTP ${response.status}: ${raw}`);
      const wire = record(JSON.parse(raw));
      if (typeof wire.quote_id !== "string" || !wire.quote_id.trim()) {
        throw new RouterSdkError("INVALID_RFQ", "Missing RFQ quote ID.");
      }
      const message = record(wire.message);
      const keys = list(message.account_keys).map((key) => base58.encode(bytes(key, 32)));
      const instructions = list(message.instructions);
      if (instructions.length !== 1) throw new RouterSdkError("INVALID_RFQ", "Expected one native PropAMM trade instruction.");
      const instruction = record(instructions[0]);
      const accounts = list(instruction.accounts).map(byte);
      const key = (position: number) => {
        const index = accounts[position];
        const address = index === undefined ? undefined : keys[index];
        if (!address) throw new RouterSdkError("INVALID_RFQ", "Invalid RFQ account index.");
        return address;
      };
      if (keys[byte(instruction.program_id_index)] !== deployment.programId
        || key(0) !== deployment.config || key(2) !== request.user
        || key(8) !== deployment.baseMint || key(9) !== deployment.quoteMint) {
        throw new RouterSdkError("INVALID_RFQ", "RFQ program, config, user or mint does not match the request.");
      }
      const data = bytes(instruction.data);
      // Native ExecuteTrade: tag, side, four compact u64 terms, input, optional minimum.
      if ((data.length !== 42 && data.length !== 50) || data[0] !== 2 || data[1] !== (buy ? 0 : 1)) {
        throw new RouterSdkError("INVALID_RFQ", "Invalid native PropAMM trade payload or side.");
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (view.getBigUint64(34, true) !== request.amountIn) {
        throw new RouterSdkError("INVALID_RFQ", "RFQ encoded input does not match the request.");
      }
      const estimate = record(wire.estimated_quote);
      return {
        quoteId: wire.quote_id, quoteSigner: key(1),
        terms: {
          side, baseAmount: view.getBigUint64(2, true), quoteAmount: view.getBigUint64(10, true),
          expiryMs: view.getBigUint64(18, true), nonce: view.getBigUint64(26, true),
        },
        estimatedAmountOut: outputAmount(buy ? estimate.base_amount : estimate.quote_amount),
      };
    },
  };
}
