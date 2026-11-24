import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeNativeSwapExample } from "../../examples/native-swap.js";
import { fixtureNow, hash, json, mockClient, fixture, requestFor, userSignature } from "../helpers/native-swap.js";

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(fixtureNow));
afterEach(() => vi.restoreAllMocks());

it("reviews the quote, asks the app wallet to sign, submits, and confirms through the app", async () => {
  const entry = fixture("mixed-three-hop"), { client, fetcher } = mockClient();
  fetcher.mockResolvedValueOnce(json(entry.quote)).mockResolvedValueOnce(json({ transaction_hash: hash }));
  const calls: string[] = [];
  const result = await executeNativeSwapExample(client, requestFor(entry), {
    async reviewQuote(quote) {
      calls.push("review");
      expect(quote.intermediateLeftovers).toHaveLength(2);
      expect(fetcher).toHaveBeenCalledOnce();
    },
    async signMessage(message) {
      calls.push("wallet");
      expect(Array.from(message.recent_blockhash)).toEqual(entry.quote.transaction.message.recent_blockhash);
      return userSignature();
    },
    async confirm(transactionHash) { calls.push("confirm"); expect(transactionHash).toBe(hash); },
  });
  expect(calls).toEqual(["review", "wallet", "confirm"]);
  expect(result.transactionHash).toBe(hash);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("checks freshness before opening the wallet after quote review", async () => {
  const entry = fixture(), { client, fetcher } = mockClient();
  fetcher.mockResolvedValueOnce(json(entry.quote));
  const signMessage = vi.fn(async () => userSignature()), confirm = vi.fn();
  await expect(executeNativeSwapExample(client, requestFor(entry), {
    async reviewQuote(quote) { vi.mocked(Date.now).mockReturnValue(quote.expiresAtMs); },
    signMessage, confirm,
  })).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
  expect(signMessage).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce();
});

it("rejects a quote that expires while the wallet prompt is open", async () => {
  const entry = fixture(), { client, fetcher } = mockClient();
  fetcher.mockResolvedValueOnce(json(entry.quote));
  const confirm = vi.fn();
  await expect(executeNativeSwapExample(client, requestFor(entry), {
    async reviewQuote() {},
    async signMessage() { vi.mocked(Date.now).mockReturnValue(entry.quote.expires_at_ms); return userSignature(); },
    confirm,
  })).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
});

it("propagates wallet rejection before submission", async () => {
  const entry = fixture(), { client, fetcher } = mockClient(), rejection = new Error("User declined");
  fetcher.mockResolvedValueOnce(json(entry.quote));
  const confirm = vi.fn();
  await expect(executeNativeSwapExample(client, requestFor(entry), {
    async reviewQuote() {}, async signMessage() { throw rejection; }, confirm,
  })).rejects.toBe(rejection);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
});

it("leaves uncertain submission recovery to the app without confirming or retrying", async () => {
  const entry = fixture(), { client, fetcher } = mockClient();
  fetcher.mockResolvedValueOnce(json(entry.quote)).mockRejectedValueOnce(new Error("lost response"));
  const confirm = vi.fn();
  await expect(executeNativeSwapExample(client, requestFor(entry), {
    async reviewQuote() {}, async signMessage() { return userSignature(); }, confirm,
  })).rejects.toMatchObject({ code: "SUBMISSION_UNCERTAIN", submissionUncertain: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(confirm).not.toHaveBeenCalled();
});
