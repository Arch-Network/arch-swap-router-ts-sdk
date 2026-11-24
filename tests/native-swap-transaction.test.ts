import { SanitizedMessageUtil, TransactionUtil, type RuntimeTransaction } from "@arch-network/arch-sdk";
import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachUserSignature, createSwapClient, serializeSwapQuote } from "../src/index.js";
import {
  fixture, fixtureNow, hash, json, mockClient, packetFixtures,
  quoted, requestFor, service, userSignature,
} from "./helpers/native-swap.js";

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(fixtureNow));
afterEach(() => vi.restoreAllMocks());

describe("native wallet signature attachment", () => {
  it.each(packetFixtures.map(entry => entry.name))("preserves the original %s message and server signature slots", async name => {
    const { quote, entry } = await quoted(name), signature = userSignature();
    const signed = attachUserSignature(quote, signature);
    const user = quote.requiredSigners.find(signer => signer.role === "user")!;
    expect(signed).not.toBe(quote.transaction);
    expect(hex.encode(SanitizedMessageUtil.serialize(signed.message))).toBe(entry.message_hex);
    expect(signed.signatures[user.index]).toEqual(signature);
    for (const signer of quote.requiredSigners.filter(signer => signer.role === "treasury")) {
      expect(signed.signatures[signer.index]).toEqual(new Uint8Array(64));
    }
    expect(quote.transaction.signatures.every(signature => signature.every(byte => byte === 0))).toBe(true);
    signature.fill(8);
    expect(signed.signatures[user.index]).toEqual(userSignature());
    signed.message.recent_blockhash[0] ^= 1;
    expect(hex.encode(TransactionUtil.serialize(quote.transaction))).toBe(entry.transaction_hex);
  });

  it("uses declared signer positions instead of assuming the user's slot", async () => {
    const entry = fixture(), { client, fetcher } = mockClient();
    const keys = entry.quote.transaction.message.account_keys;
    [keys[0], keys[1]] = [keys[1]!, keys[0]!];
    const signers = entry.quote.required_signers;
    [signers[0], signers[1]] = [signers[1]!, signers[0]!];
    signers.forEach((signer, index) => { signer.index = index; });
    fetcher.mockResolvedValueOnce(json(entry.quote));
    const quote = await client.quote(requestFor(entry));
    const signed = attachUserSignature(quote, userSignature());
    expect(signed.signatures[0]).toEqual(new Uint8Array(64));
    expect(signed.signatures[1]).toEqual(userSignature());
  });

  it.each([new Uint8Array(63), new Uint8Array(65), new Uint8Array(64), Array(64).fill(7)])(
    "rejects malformed or absent user signatures %#", async signature => {
      const { quote } = await quoted();
      expect(() => attachUserSignature(quote, signature as Uint8Array)).toThrow(expect.objectContaining({ code: "INVALID_SIGNATURE" }));
    },
  );

  it("rejects copied/unrecognized quote objects", async () => {
    const { quote } = await quoted();
    expect(() => attachUserSignature({ ...quote }, userSignature())).toThrow(expect.objectContaining({ code: "UNKNOWN_QUOTE" }));
  });
});

describe("packet and quote integrity", () => {
  const edits: [string, (tx: RuntimeTransaction) => void][] = [
    ["blockhash", tx => { tx.message.recent_blockhash[0] ^= 1; }],
    ["instruction data", tx => { tx.message.instructions[0]!.data[0] ^= 1; }],
    ["instruction accounts", tx => { tx.message.instructions.find(ix => ix.accounts.length > 1)!.accounts.reverse(); }],
    ["account keys", tx => { tx.message.account_keys[2]![0] ^= 1; }],
    ["additional instruction", tx => { tx.message.instructions.push(structuredClone(tx.message.instructions[0]!)); }],
    ["transaction version", tx => { tx.version = 1; }],
  ];
  it.each(edits)("detects original %s mutations using a private snapshot", async (_name, edit) => {
    const { client, fetcher, quote } = await quoted();
    const signed = attachUserSignature(quote, userSignature());
    edit(quote.transaction);
    expect(() => attachUserSignature(quote, userSignature())).toThrow(expect.objectContaining({ code: "MESSAGE_CHANGED" }));
    await expect(client.submit(quote, signed)).rejects.toMatchObject({ code: "MESSAGE_CHANGED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(edits)("rejects signed %s changes before HTTP", async (_name, edit) => {
    const { client, fetcher, quote } = await quoted();
    const signed = attachUserSignature(quote, userSignature());
    edit(signed);
    await expect(client.submit(quote, signed)).rejects.toBeInstanceOf(Error);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["quoteId", "expiresAtMs"] as const)("rejects changed %s instead of trusting mutable metadata", async field => {
    const { client, fetcher, quote } = await quoted();
    const signed = attachUserSignature(quote, userSignature());
    Object.assign(quote, field === "quoteId" ? { quoteId: "c".repeat(64) } : { expiresAtMs: quote.expiresAtMs + 900000 });
    await expect(client.submit(quote, signed)).rejects.toMatchObject({ code: "MESSAGE_CHANGED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["zero user signature", "populated treasury", "missing slot", "short signature", "sparse slots"])(
    "rejects %s before HTTP", async mode => {
      const { client, fetcher, quote } = await quoted();
      const signed = attachUserSignature(quote, userSignature());
      if (mode === "zero user signature") signed.signatures[0]!.fill(0);
      if (mode === "populated treasury") signed.signatures[1]![0] = 1;
      if (mode === "missing slot") signed.signatures.pop();
      if (mode === "short signature") signed.signatures[0] = new Uint8Array(63);
      if (mode === "sparse slots") delete signed.signatures[0];
      await expect(client.submit(quote, signed)).rejects.toBeInstanceOf(Error);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("rejects a quote submitted to another service", async () => {
    const { quote } = await quoted();
    const fetcher = vi.fn<typeof fetch>();
    const other = createSwapClient({ baseUrl: "https://other.test", fetch: fetcher });
    await expect(other.submit(quote, attachUserSignature(quote, userSignature()))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows another client for the same service to submit the original quote", async () => {
    const { quote } = await quoted();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ transaction_hash: hash }));
    await expect(createSwapClient({ baseUrl: service, fetch: fetcher }).submit(quote, attachUserSignature(quote, userSignature())))
      .resolves.toEqual({ transactionHash: hash });
  });

  it("allows an application wallet to populate the original user slot directly", async () => {
    const { client, fetcher, quote } = await quoted();
    quote.transaction.signatures[0] = userSignature();
    fetcher.mockResolvedValueOnce(json({ transaction_hash: hash }));
    await expect(client.submit(quote, quote.transaction)).resolves.toEqual({ transactionHash: hash });
  });
});

describe("freshness around signing", () => {
  it("rejects a response that expired while the quote HTTP request was pending", async () => {
    const entry = fixture(), { client, fetcher } = mockClient();
    fetcher.mockImplementationOnce(async () => {
      vi.mocked(Date.now).mockReturnValue(entry.quote.expires_at_ms);
      return json(entry.quote);
    });
    await expect(client.quote(requestFor(entry))).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
  });

  it("rejects expired attachment and submission after a wallet prompt", async () => {
    const { client, fetcher, quote } = await quoted();
    const signed = attachUserSignature(quote, userSignature());
    vi.mocked(Date.now).mockReturnValue(quote.expiresAtMs);
    expect(() => attachUserSignature(quote, userSignature())).toThrow(expect.objectContaining({ code: "QUOTE_EXPIRED" }));
    await expect(client.submit(quote, signed)).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("portable native quote flow state", () => {
  it("restores a JSON-safe quote on another client without fetching or refreshing it", async () => {
    const { quote, entry } = await quoted("mixed-three-hop");
    const serialized = serializeSwapQuote(quote);
    expect(JSON.parse(JSON.stringify(serialized))).toBe(serialized);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ transaction_hash: hash }));
    const client = createSwapClient({ baseUrl: service, fetch: fetcher });
    const restored = client.restoreQuote(serialized);
    expect(fetcher).not.toHaveBeenCalled();
    expect(restored.quoteId).toBe(quote.quoteId);
    expect(hex.encode(TransactionUtil.serialize(restored.transaction))).toBe(entry.transaction_hex);
    await expect(client.submit(restored, attachUserSignature(restored, userSignature()))).resolves.toEqual({ transactionHash: hash });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("serializes the original unsigned response without carrying wallet signatures", async () => {
    const { quote } = await quoted();
    const original = serializeSwapQuote(quote);
    quote.transaction.signatures[0] = userSignature();
    expect(serializeSwapQuote(quote)).toBe(original);
    const restored = createSwapClient({ baseUrl: service }).restoreQuote(original);
    expect(restored.transaction.signatures.every(signature => signature.every(byte => byte === 0))).toBe(true);
  });

  it("uses the injected clock for quoting, restoration, and signature attachment", async () => {
    const entry = fixture();
    vi.mocked(Date.now).mockReturnValue(entry.quote.expires_at_ms + 1000);
    let now = fixtureNow;
    const client = createSwapClient({
      baseUrl: service, clock: () => now,
      fetch: async () => ({ status: 200, text: async () => JSON.stringify(entry.quote) }),
    });
    const quote = await client.quote(requestFor(entry));
    const serialized = serializeSwapQuote(quote);
    expect(attachUserSignature(client.restoreQuote(serialized), userSignature()).signatures[0]).toEqual(userSignature());
    now = quote.expiresAtMs;
    expect(() => client.restoreQuote(serialized)).toThrow(expect.objectContaining({ code: "QUOTE_EXPIRED" }));
    expect(() => attachUserSignature(quote, userSignature())).toThrow(expect.objectContaining({ code: "QUOTE_EXPIRED" }));
  });

  it("rejects another service, malformed state, and altered original packets", async () => {
    const { quote } = await quoted();
    const serialized = serializeSwapQuote(quote);
    expect(() => createSwapClient({ baseUrl: "https://other.test" }).restoreQuote(serialized))
      .toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => createSwapClient({ baseUrl: service }).restoreQuote("{}"))
      .toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
    quote.transaction.message.recent_blockhash[0] ^= 1;
    expect(() => serializeSwapQuote(quote)).toThrow(expect.objectContaining({ code: "MESSAGE_CHANGED" }));
  });
});

it("revalidates intermediate remainder arithmetic when restoring opaque flow state", async () => {
  const { client, quote } = await quoted("mixed-three-hop");
  const saved = JSON.parse(serializeSwapQuote(quote));
  saved.response.intermediate_leftovers[0].estimated_amount = "497";
  expect(() => client.restoreQuote(JSON.stringify(saved))).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
});
