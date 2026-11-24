import { SanitizedMessageUtil, TransactionUtil } from "@arch-network/arch-sdk";
import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachUserSignature, createSwapClient, SwapSdkError,
  type SwapQuoteRequest,
} from "../src/index.js";
import {
  fixture, fixtureNow, hash, json, mockClient, packetFixtures,
  quoted, requestFor, service, userSignature,
} from "./helpers/native-swap.js";

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(fixtureNow));
afterEach(() => vi.restoreAllMocks());

describe("native swap API client", () => {
  it("constructs without requests and discovers pairs asynchronously without caching", async () => {
    const { client, fetcher } = mockClient();
    expect(fetcher).not.toHaveBeenCalled();
    const entry = fixture(), request = requestFor(entry);
    const response = {
      tokens: [
        { mint: request.inputMint, symbol: "IN", decimals: 8 },
        { mint: request.outputMint, symbol: "OUT", decimals: 6 },
      ],
      pairs: [{ input_mint: request.inputMint, output_mint: request.outputMint }],
    };
    fetcher.mockImplementation(async () => json(response));
    const signal = new AbortController().signal;
    const result = await client.getPairs({ signal });
    expect(result).toEqual({
      tokens: response.tokens, pairs: [{ inputMint: request.inputMint, outputMint: request.outputMint }],
    });
    await client.getPairs();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(1, service + "/v1/swap/pairs", { method: "GET", signal });
  });

  it.each(packetFixtures.map(entry => entry.name))("decodes the real Rust %s packet byte for byte", async name => {
    const entry = fixture(name), request = requestFor(entry);
    const { client, fetcher } = mockClient();
    fetcher.mockResolvedValueOnce(json(entry.quote));
    const quote = await client.quote(request);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(service + "/v1/swap/quote", {
      method: "POST", headers: { "content-type": "application/json" }, body: expect.any(String),
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(entry.request);
    expect(quote).toMatchObject({
      quoteId: entry.quote.quote_id, inputMint: request.inputMint, outputMint: request.outputMint,
      inputBudget: request.maxAmountIn, guaranteedAmountOut: BigInt(entry.quote.guaranteed_amount_out),
      estimatedAmountIn: BigInt(entry.quote.estimated_amount_in), maxAmountIn: BigInt(entry.quote.max_amount_in),
      expiresAtMs: entry.quote.expires_at_ms, serializedSize: entry.quote.serialized_size,
    });
    expect(TransactionUtil.toNumberArray(quote.transaction)).toEqual(entry.quote.transaction);
    expect(hex.encode(SanitizedMessageUtil.serialize(quote.transaction.message))).toBe(entry.message_hex);
    expect(hex.encode(TransactionUtil.serialize(quote.transaction))).toBe(entry.transaction_hex);
    expect(quote.unusedInput.estimatedAmount).toBe(BigInt(entry.quote.unused_input.estimated_amount));
    expect(quote.intermediateLeftovers.map(item => item.minimumAmount))
      .toEqual(entry.quote.intermediate_leftovers.map(item => BigInt(item.minimum_amount)));
    expect(quote.route.map(leg => leg.venue)).toEqual(entry.quote.route.map(leg => leg.venue));
  });

  it("preserves amounts above JavaScript's safe integer range", async () => {
    const { quote } = await quoted();
    expect(quote.inputBudget).toBe(9007199254740993n);
    expect(quote.route[0]!.maxAmountIn).toBe(9007199254740993n);
  });

  it.each([0, 50, 10000])("forwards %s bps without applying output slippage a second time", async slippageBps => {
    const entry = fixture(), { client, fetcher } = mockClient();
    fetcher.mockResolvedValueOnce(json(entry.quote));
    const quote = await client.quote({ ...requestFor(entry), slippageBps });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).slippage_bps).toBe(slippageBps);
    expect(quote.guaranteedAmountOut).toBe(BigInt(entry.quote.guaranteed_amount_out));
  });

  it("captures the request before awaiting HTTP", async () => {
    const entry = fixture(), request = { ...requestFor(entry) }, { client, fetcher } = mockClient();
    fetcher.mockResolvedValueOnce(json(entry.quote));
    const pending = client.quote(request);
    request.maxAmountIn = 1n;
    request.user = request.inputMint;
    expect((await pending).inputBudget).toBe(9007199254740993n);
  });

  it.each([
    { maxAmountIn: 0n }, { maxAmountIn: -1n }, { maxAmountIn: 1n << 64n },
    { maxAmountIn: 1 }, { slippageBps: -1 }, { slippageBps: 10001 }, { slippageBps: 0.1 },
    { inputMint: "not-base58!" }, { user: "" }, { outputMint: fixture().request.input_mint },
  ])("rejects invalid requests before HTTP: %#", async patch => {
    const { client, fetcher } = mockClient();
    await expect(client.quote({ ...requestFor(), ...patch } as SwapQuoteRequest)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("encodes the full u64 maximum without a Number conversion", async () => {
    const { client, fetcher } = mockClient();
    fetcher.mockResolvedValueOnce(json({ code: "native_swap_input_cap_exceeded", error: "cap" }, 422));
    await expect(client.quote({ ...requestFor(), maxAmountIn: (1n << 64n) - 1n }))
      .rejects.toMatchObject({ code: "native_swap_input_cap_exceeded" });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).max_amount_in).toBe("18446744073709551615");
  });

  it.each(["/api/propamm/", "/"])("supports same-origin service path %s", async baseUrl => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ tokens: [], pairs: [] }));
    await createSwapClient({ baseUrl, fetch: fetcher }).getPairs();
    expect(fetcher.mock.calls[0]![0]).toBe(baseUrl.replace(/\/+$/, "") + "/v1/swap/pairs");
  });

  it.each(["", "//other.test/path", "ftp://example.test", "https://", "https://example.test?a=1", "/api#fragment"])(
    "rejects invalid service URL %s", baseUrl => {
      expect(() => createSwapClient({ baseUrl })).toThrow(SwapSdkError);
    },
  );

  it("uses global fetch by default", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ tokens: [], pairs: [] }));
    await createSwapClient({ baseUrl: service }).getPairs();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("response validation", () => {
  const badQuotes: [string, (wire: ReturnType<typeof fixture>["quote"]) => void][] = [
    ["impossible unused estimate", wire => { wire.unused_input.estimated_amount = "1"; }],
    ["impossible unused minimum", wire => { wire.unused_input.minimum_amount = "1"; }],
    ["numeric amount", wire => { Object.assign(wire, { input_budget: 9007199254740992 }); }],
    ["overflow amount", wire => { wire.input_budget = "18446744073709551616"; }],
    ["fractional amount", wire => { wire.input_budget = "1.5"; }],
    ["unsafe timestamp", wire => { wire.expires_at_ms = Number.MAX_SAFE_INTEGER + 1; }],
    ["different budget", wire => { wire.input_budget = "1"; }],
    ["different endpoint mint", wire => { wire.output_mint = wire.input_mint; }],
    ["wrong packet size", wire => { wire.serialized_size++; }],
    ["wrong version", wire => { wire.transaction.version = 1; }],
    ["missing signer", wire => { wire.transaction.signatures.pop(); }],
    ["nonzero server signature", wire => { wire.transaction.signatures[1]![0] = 1; }],
    ["wrong user", wire => { wire.required_signers[0]!.pubkey = wire.input_mint; }],
    ["wrong signer slot", wire => { wire.required_signers[0]!.index = 1; }],
    ["wrong signer key", wire => { wire.transaction.message.account_keys[0]![0] ^= 1; }],
    ["unknown signer role", wire => { wire.required_signers[0]!.role = "maker"; }],
    ["short blockhash", wire => { wire.transaction.message.recent_blockhash.pop(); }],
    ["invalid byte", wire => { wire.transaction.message.recent_blockhash[0] = 256; }],
    ["fractional header", wire => { wire.transaction.message.header.num_required_signatures = 1.5; }],
    ["readonly payer", wire => { wire.transaction.message.header.num_readonly_signed_accounts = 2; }],
    ["invalid program index", wire => { wire.transaction.message.instructions[0]!.program_id_index = 255; }],
    ["invalid account index", wire => { wire.transaction.message.instructions[0]!.accounts.push(255); }],
    ["invalid instruction data", wire => { wire.transaction.message.instructions[0]!.data.push(-1); }],
    ["empty instructions", wire => { wire.transaction.message.instructions = []; }],
    ["duplicate key", wire => { wire.transaction.message.account_keys[2] = wire.transaction.message.account_keys[0]!; }],
    ["missing route", wire => { wire.route = []; }],
    ["unknown venue", wire => { wire.route[0]!.venue = "vault"; }],
    ["wrong route endpoint", wire => { wire.route[0]!.input_mint = wire.output_mint; }],
    ["wrong fixed output", wire => { wire.guaranteed_amount_out = "1"; }],
    ["wrong remainder mint", wire => { wire.unused_input.mint = wire.output_mint; }],
    ["invalid remainder bound", wire => { wire.unused_input.minimum_amount = "1"; }],
    ["packet above runtime limit", wire => { wire.transaction.message.instructions[0]!.data = new Array(4096).fill(0); }],
  ];
  it.each(badQuotes)("rejects %s", async (_name, edit) => {
    const entry = fixture(), { client, fetcher } = mockClient();
    edit(entry.quote);
    fetcher.mockResolvedValueOnce(json(entry.quote));
    await expect(client.quote(requestFor(entry))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects pair metadata referencing an unlisted token", async () => {
    const { client, fetcher } = mockClient();
    fetcher.mockResolvedValueOnce(json({ tokens: [], pairs: [{ input_mint: requestFor().inputMint, output_mint: requestFor().outputMint }] }));
    await expect(client.getPairs()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each(["not json", "null", "[]"])("rejects malformed discovery response %s", async body => {
    const { client, fetcher } = mockClient();
    fetcher.mockResolvedValueOnce(new Response(body));
    await expect(client.getPairs()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("errors and cancellation", () => {
  it("preserves server codes, cap diagnostics, and full-width amounts", async () => {
    const { client, fetcher } = mockClient(), request = requestFor();
    fetcher.mockResolvedValueOnce(json({
      code: "native_swap_input_cap_exceeded", error: "input cap",
      failures: [{
        code: "native_swap_input_cap_exceeded", error: "input cap",
        route: [request.inputMint, request.outputMint], leg_index: 0,
        cap: { kind: "input", mint: request.inputMint, amount: "9007199254740993", limit: "9007199254740992" },
      }],
    }, 422));
    await expect(client.quote(request)).rejects.toMatchObject({
      name: "SwapSdkError", status: 422, code: "native_swap_input_cap_exceeded",
      failures: [{ legIndex: 0, cap: { amount: 9007199254740993n, limit: 9007199254740992n } }],
      submissionUncertain: false,
    });
  });

  it("reports disabled APIs without retrying or using a legacy endpoint", async () => {
    const { client, fetcher } = mockClient();
    fetcher.mockResolvedValueOnce(json({ code: "native_routing_disabled", error: "disabled" }, 503));
    await expect(client.getPairs()).rejects.toMatchObject({ code: "native_routing_disabled", status: 503 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("distinguishes a failed read from uncertain submission", async () => {
    const { client, fetcher } = mockClient();
    const cause = new Error("connection closed");
    fetcher.mockRejectedValueOnce(cause);
    await expect(client.getPairs()).rejects.toMatchObject({ code: "NETWORK_ERROR", cause, submissionUncertain: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not dispatch an already-aborted request", async () => {
    const { client, fetcher } = mockClient();
    const controller = new AbortController();
    controller.abort("cancel");
    await expect(client.quote(requestFor(), { signal: controller.signal })).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards the signal and classifies a cancelled in-flight read", async () => {
    const { client, fetcher } = mockClient(), controller = new AbortController();
    fetcher.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = client.getPairs({ signal: controller.signal });
    controller.abort("cancel");
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_ABORTED", submissionUncertain: false });
  });

  it("preserves cancellation when the read response body is interrupted", async () => {
    const { client, fetcher } = mockClient(), controller = new AbortController();
    const response = json({ tokens: [], pairs: [] });
    vi.spyOn(response, "text").mockImplementationOnce(async () => {
      controller.abort("body interrupted");
      throw new Error("body interrupted");
    });
    fetcher.mockResolvedValueOnce(response);
    await expect(client.getPairs({ signal: controller.signal })).rejects.toMatchObject({
      code: "REQUEST_ABORTED", submissionUncertain: false,
    });
  });
});

describe("submission and attempt recovery", () => {
  it("submits the exact nested packet and returns acknowledgement without confirmation", async () => {
    const { client, fetcher, quote } = await quoted("mixed-three-hop");
    const signed = attachUserSignature(quote, userSignature());
    fetcher.mockResolvedValueOnce(json({ transaction_hash: hash }));
    await expect(client.submit(quote, signed)).resolves.toEqual({ transactionHash: hash });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(service + "/v1/swap/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote_id: quote.quoteId, transaction: TransactionUtil.toNumberArray(signed) }),
    });
  });

  it("freezes the wire body before awaiting the HTTP acknowledgement", async () => {
    const { client, fetcher, quote } = await quoted();
    const signed = attachUserSignature(quote, userSignature());
    fetcher.mockResolvedValueOnce(json({ transaction_hash: hash }));
    const pending = client.submit(quote, signed);
    signed.signatures[0]!.fill(9);
    await pending;
    const wire = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(wire.transaction.signatures[0]).toEqual(Array(64).fill(7));
  });

  it.each(["native_swap_submission_uncertain", "native_swap_submission_hash_mismatch"])(
    "preserves %s and its recovery hash", async code => {
      const { client, fetcher, quote } = await quoted();
      fetcher.mockResolvedValueOnce(json({ code, error: "no acknowledgement", transaction_hash: hash }, 502));
      await expect(client.submit(quote, attachUserSignature(quote, userSignature()))).rejects.toMatchObject({
        code, transactionHash: hash, status: 502, submissionUncertain: true,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("preserves definite node rejection without treating it as acknowledgement", async () => {
    const { client, fetcher, quote } = await quoted();
    fetcher.mockResolvedValueOnce(json({ code: "native_swap_submission_rejected", error: "fee payer", transaction_hash: hash }, 422));
    await expect(client.submit(quote, attachUserSignature(quote, userSignature()))).rejects.toMatchObject({
      code: "native_swap_submission_rejected", transactionHash: hash, submissionUncertain: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["network", "body lost", "malformed JSON", "missing hash", "invalid hash", "proxy error"])(
    "treats %s after dispatch as uncertain without retries", async mode => {
      const { client, fetcher, quote } = await quoted();
      if (mode === "network") fetcher.mockRejectedValueOnce(new Error("socket closed"));
      else if (mode === "body lost") {
        const response = json({ transaction_hash: hash });
        vi.spyOn(response, "text").mockRejectedValueOnce(new Error("truncated"));
        fetcher.mockResolvedValueOnce(response);
      } else fetcher.mockResolvedValueOnce(mode === "malformed JSON" ? new Response("{")
        : mode === "missing hash" ? json({}) : mode === "invalid hash" ? json({ transaction_hash: "bad" })
        : new Response("upstream failed", { status: 502 }));
      await expect(client.submit(quote, attachUserSignature(quote, userSignature()))).rejects.toMatchObject({
        code: "SUBMISSION_UNCERTAIN", submissionUncertain: true,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("classifies cancellation after submit dispatch as uncertain", async () => {
    const { client, fetcher, quote } = await quoted(), controller = new AbortController();
    fetcher.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = client.submit(quote, attachUserSignature(quote, userSignature()), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "SUBMISSION_UNCERTAIN", submissionUncertain: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not dispatch an already-aborted signed submission", async () => {
    const { client, fetcher, quote } = await quoted(), controller = new AbortController();
    controller.abort();
    await expect(client.submit(quote, attachUserSignature(quote, userSignature()), { signal: controller.signal }))
      .rejects.toMatchObject({ code: "REQUEST_ABORTED", submissionUncertain: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["estimated_amount", "minimum_amount"] as const)("refuses an impossible intermediate %s", async field => {
    const entry = fixture("mixed-three-hop");
    entry.quote.intermediate_leftovers[0]![field] = "9999999";
    const { client, fetcher } = mockClient();
    fetcher.mockResolvedValueOnce(json(entry.quote));
    await expect(client.quote(requestFor(entry))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    ["native_quote_expired", 410], ["native_quote_busy", 409],
  ] as const)("preserves server preflight %s without a replacement quote or retry", async (code, status) => {
    const { client, fetcher, quote } = await quoted();
    fetcher.mockResolvedValueOnce(json({ code, error: "preflight failed" }, status));
    await expect(client.submit(quote, attachUserSignature(quote, userSignature()))).rejects.toMatchObject({
      code, status, submissionUncertain: status === 409,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["submitting", "accepted", "rejected", "unknown"])("returns %s attempt metadata even after quote expiry", async outcome => {
    const { client, fetcher, quote } = await quoted();
    vi.mocked(Date.now).mockReturnValue(quote.expiresAtMs + 1);
    fetcher.mockResolvedValueOnce(json({
      quote_id: quote.quoteId, transaction_hash: hash, outcome,
      attempted_at_ms: fixtureNow, expires_at_ms: fixtureNow + 900000,
    }));
    await expect(client.getAttempt(quote.quoteId)).resolves.toEqual({
      quoteId: quote.quoteId, transactionHash: hash, outcome,
      attemptedAtMs: fixtureNow, expiresAtMs: fixtureNow + 900000,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(service + "/v1/swap/attempt/" + quote.quoteId, { method: "GET" });
  });

  it("recovers a hash after a lost submit response using only explicit attempt lookup", async () => {
    const { client, fetcher, quote } = await quoted();
    fetcher.mockRejectedValueOnce(new Error("lost response"));
    await expect(client.submit(quote, attachUserSignature(quote, userSignature()))).rejects.toMatchObject({ code: "SUBMISSION_UNCERTAIN" });
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(json({
      quote_id: quote.quoteId, transaction_hash: hash, outcome: "accepted",
      attempted_at_ms: fixtureNow, expires_at_ms: fixtureNow + 900000,
    }));
    expect((await client.getAttempt(quote.quoteId)).transactionHash).toBe(hash);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("surfaces missing attempt metadata without creating a fresh trade", async () => {
    const { client, fetcher, quote } = await quoted();
    fetcher.mockResolvedValueOnce(json({ code: "native_swap_attempt_not_found", error: "not retained" }, 404));
    await expect(client.getAttempt(quote.quoteId)).rejects.toMatchObject({ status: 404, code: "native_swap_attempt_not_found" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("surfaces consumed quote IDs as unresolved rather than proof of no broadcast", async () => {
    const { client, fetcher, quote } = await quoted();
    fetcher.mockResolvedValueOnce(json({ code: "native_quote_not_found", error: "missing or consumed" }, 404));
    await expect(client.submit(quote, attachUserSignature(quote, userSignature()))).rejects.toMatchObject({
      code: "native_quote_not_found", submissionUncertain: true,
    });
  });

  it("rejects an invalid lookup ID locally", async () => {
    const { client, fetcher } = mockClient();
    await expect(client.getAttempt("../quote")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["wrong ID", "unknown outcome", "unsafe timestamp", "bad hash"])("rejects attempt metadata with %s", async mode => {
    const { client, fetcher } = mockClient(), quoteId = fixture().quote.quote_id;
    const wire = {
      quote_id: quoteId, transaction_hash: hash, outcome: "unknown",
      attempted_at_ms: fixtureNow, expires_at_ms: fixtureNow + 900000,
    };
    if (mode === "wrong ID") wire.quote_id = "c".repeat(64);
    if (mode === "unknown outcome") wire.outcome = "confirmed";
    if (mode === "unsafe timestamp") wire.expires_at_ms = Number.MAX_SAFE_INTEGER + 1;
    if (mode === "bad hash") wire.transaction_hash = "bad";
    fetcher.mockResolvedValueOnce(json(wire));
    await expect(client.getAttempt(quoteId)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
