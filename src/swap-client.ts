import { U64_MAX } from "./integers.js";
import { address, amount, decodeApiError, decodeAttempt, decodePairs, decodeQuote, decodeSubmit, identifier, record } from "./swap-codec.js";
import { SwapSdkError } from "./swap-errors.js";
import { rememberQuote, submissionBody } from "./swap-transaction.js";
import type { SwapClient, SwapClientOptions, SwapHttpResponse, SwapQuoteRequest, SwapRequestOptions } from "./swap-types.js";

function validateRequest(request: SwapQuoteRequest): void {
  try {
    address(request.inputMint); address(request.outputMint); address(request.user);
    if (request.inputMint === request.outputMint) throw new Error("Input and output mints must differ.");
    if (typeof request.maxAmountIn !== "bigint" || request.maxAmountIn <= 0n || request.maxAmountIn > U64_MAX) {
      throw new Error("maxAmountIn must be a positive u64 bigint.");
    }
    if (request.slippageBps !== undefined && (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 10000)) {
      throw new Error("slippageBps must be an integer in 0..10000.");
    }
  } catch (cause) {
    throw new SwapSdkError("INVALID_REQUEST", cause instanceof Error ? cause.message : "Invalid quote request.", { cause });
  }
}

export function createSwapClient(options: SwapClientOptions): SwapClient {
  if (typeof options.baseUrl !== "string") throw new SwapSdkError("INVALID_REQUEST", "baseUrl must be a string.");
  const service = options.baseUrl.replace(/\/+$/, "");
  if (/[?#]/.test(service) || (!/^https?:\/\//i.test(service) && !/^\/(?!\/)/.test(options.baseUrl))) {
    throw new SwapSdkError("INVALID_REQUEST", "baseUrl must be an HTTP(S) URL or a root-relative service path without a query or fragment.");
  }
  if (/^https?:/i.test(service)) {
    try { new URL(service); }
    catch (cause) { throw new SwapSdkError("INVALID_REQUEST", "Invalid service URL.", { cause }); }
  }
  const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const clock = options.clock ?? Date.now;
  if (typeof fetcher !== "function") throw new SwapSdkError("INVALID_REQUEST", "Provide a fetch implementation.");
  if (typeof clock !== "function") throw new SwapSdkError("INVALID_REQUEST", "Provide a clock function.");

  function restored(serialized: string) {
    let value: Record<string, unknown>;
    let input: SwapQuoteRequest;
    try {
      value = record(JSON.parse(serialized));
      if (value.format !== "arch.swap.quote.v1" || value.service !== service) throw new Error("Quote format or service URL differs.");
      const wire = record(value.request);
      input = {
        inputMint: address(wire.input_mint), outputMint: address(wire.output_mint),
        user: address(wire.user_pubkey), maxAmountIn: amount(wire.max_amount_in),
        ...(wire.slippage_bps === undefined ? {} : { slippageBps: wire.slippage_bps as number }),
      };
      validateRequest(input);
    } catch (cause) {
      throw new SwapSdkError("INVALID_REQUEST", "Invalid serialized quote.", { cause });
    }
    const quote = decodeQuote(value.response, input);
    return rememberQuote(quote, service, clock, serialized);
  }

  async function request<T>(path: string, decode: (value: unknown) => T, options: SwapRequestOptions = {}, body?: string): Promise<T> {
    const submitting = path === "/v1/swap/submit";
    if (options.signal?.aborted) throw new SwapSdkError("REQUEST_ABORTED", "Request was aborted before dispatch.", { cause: options.signal.reason });
    let response: SwapHttpResponse;
    try {
      response = await fetcher(service + path, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      throw new SwapSdkError(submitting ? "SUBMISSION_UNCERTAIN" : options.signal?.aborted ? "REQUEST_ABORTED" : "NETWORK_ERROR",
        submitting ? "Submission acknowledgement was lost; reconcile this quote before authorizing another trade." : "Swap API request failed.",
        { cause, submissionUncertain: submitting });
    }
    let result: T | SwapSdkError;
    try {
      const value: unknown = JSON.parse(await response.text());
      result = response.status >= 200 && response.status < 300 ? decode(value) : decodeApiError(value, response.status, submitting);
    } catch (cause) {
      throw new SwapSdkError(submitting ? "SUBMISSION_UNCERTAIN" : options.signal?.aborted ? "REQUEST_ABORTED" : "INVALID_RESPONSE",
        "The swap API returned an unreadable or invalid response.",
        { status: response.status, cause, submissionUncertain: submitting });
    }
    if (result instanceof SwapSdkError) throw result;
    return result;
  }

  return Object.freeze<SwapClient>({
    getPairs: options => request("/v1/swap/pairs", decodePairs, options),
    async quote(input, options) {
      const captured = { ...input };
      validateRequest(captured);
      const body = JSON.stringify({
        input_mint: captured.inputMint, output_mint: captured.outputMint,
        max_amount_in: captured.maxAmountIn.toString(), user_pubkey: captured.user,
        ...(captured.slippageBps === undefined ? {} : { slippage_bps: captured.slippageBps }),
      });
      const answer = await request("/v1/swap/quote", value => ({ quote: decodeQuote(value, captured), response: value }), options, body);
      return rememberQuote(answer.quote, service, clock, JSON.stringify({
        format: "arch.swap.quote.v1", service, request: JSON.parse(body) as unknown, response: answer.response,
      }));
    },
    restoreQuote: restored,
    async submit(quote, transaction, options) {
      const body = submissionBody(quote, transaction, service);
      return request("/v1/swap/submit", decodeSubmit, options, body);
    },
    getAttempt: async (quoteId, options) => {
      try { identifier(quoteId); }
      catch (cause) { throw new SwapSdkError("INVALID_REQUEST", "Invalid quote ID.", { cause }); }
      return request("/v1/swap/attempt/" + quoteId, value => decodeAttempt(value, quoteId), options);
    },
  });
}
