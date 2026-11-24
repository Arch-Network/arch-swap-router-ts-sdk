import { vi } from "vitest";
import { createSwapClient, type SwapQuoteRequest } from "../../src/index.js";
import native from "../fixtures/native-swap/native.json" with { type: "json" };

export const packetFixtures = native.cases;
export const hash = "b".repeat(64);
export const service = "https://example.test/propamm";
export const fixtureNow = Math.min(...packetFixtures.map(entry => entry.quote.expires_at_ms)) - 1000;
export const userSignature = () => new Uint8Array(64).fill(7);
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

export function fixture(name = "treasury") {
  const entry = packetFixtures.find(entry => entry.name === name);
  if (!entry) throw new Error("Missing native fixture: " + name);
  return structuredClone(entry);
}

export function requestFor(entry = fixture()): SwapQuoteRequest {
  const wire = entry.request;
  return {
    inputMint: wire.input_mint, outputMint: wire.output_mint,
    maxAmountIn: BigInt(wire.max_amount_in), user: wire.user_pubkey,
    ...(wire.slippage_bps === undefined ? {} : { slippageBps: wire.slippage_bps }),
  };
}

export function mockClient() {
  const fetcher = vi.fn<typeof globalThis.fetch>();
  const client = createSwapClient({ baseUrl: service + "///", fetch: fetcher });
  return { client, fetcher };
}

export async function quoted(name = "treasury") {
  const entry = fixture(name);
  const { client, fetcher } = mockClient();
  fetcher.mockResolvedValueOnce(json(entry.quote));
  const quote = await client.quote(requestFor(entry));
  fetcher.mockClear();
  return { client, fetcher, quote, entry };
}
