import { base58, hex } from "@scure/base";
import { afterEach, expect, it, vi } from "vitest";
import { NETWORKS } from "../src/config/networks.js";
import native from "./fixtures/propamm/trades.json" with { type: "json" };
import { createMainnetPropAmmRfqProvider } from "./helpers/propamm-rfq.js";

const deployment = NETWORKS.mainnet.propammMarkets[0]!;
const rfqUrl = "https://vaults.veloxapi.net/propamm/rfq";
const user = base58.encode(new Uint8Array(32).fill(1));
const signer = base58.encode(new Uint8Array(32).fill(2));

function fixture(trade = native.trades[0]!, length = 42) {
  const buy = trade.side === "Buy";
  const request = {
    inputMint: buy ? deployment.quoteMint : deployment.baseMint,
    outputMint: buy ? deployment.baseMint : deployment.quoteMint,
    amountIn: BigInt(trade.amount_in), user,
  };
  // Native Rust ExecuteTrade bytes; deliberately shuffle message keys to test
  // account-index resolution rather than assuming the signer is message key 1.
  const wire = {
    quote_id: "test-rfq",
    message: {
      account_keys: [deployment.programId, deployment.baseMint, user, signer,
        deployment.quoteMint, deployment.config].map((key) => Array.from(base58.decode(key))),
      instructions: [{
        program_id_index: 0, accounts: [5, 3, 2, 2, 2, 2, 2, 2, 1, 4],
        data: Array.from(hex.decode(trade.data_hex).subarray(0, length)),
      }],
    },
    estimated_quote: { base_amount: 99_999, quote_amount: 199_999 },
  };
  return { wire, request, buy };
}

function mockResponse(wire: unknown, status = 200) {
  return vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(wire), { status })));
}

afterEach(() => vi.unstubAllGlobals());

it.each(native.trades.flatMap((trade) => [42, 50].map((length) => ({ trade, length }))))(
  "maps native $trade.side terms from a $length-byte payload and the adjusted output",
  async ({ trade, length }) => {
    const { wire, request, buy } = fixture(trade, length);
    mockResponse(wire);
    const quote = await createMainnetPropAmmRfqProvider(`${rfqUrl}/`).quoteExactIn(request);
    expect(quote).toEqual({
      quoteId: "test-rfq", quoteSigner: signer,
      terms: {
        side: buy ? "buy" : "sell",
        baseAmount: BigInt(trade.quoted_base_amount), quoteAmount: BigInt(trade.quoted_quote_amount),
        expiryMs: BigInt(trade.expiry_ms), nonce: BigInt(trade.nonce),
      },
      estimatedAmountOut: BigInt(buy ? wire.estimated_quote.base_amount : wire.estimated_quote.quote_amount),
    });
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${rfqUrl}/quote`);
    expect(options?.method).toBe("POST");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options?.body as string)).toEqual({
      base_mint: hex.encode(base58.decode(deployment.baseMint)),
      quote_mint: hex.encode(base58.decode(deployment.quoteMint)),
      side: buy ? "buy" : "sell", amount: trade.amount_in,
      user_pubkey: hex.encode(base58.decode(user)),
    });
  },
);

it("preserves full-u64 request and native term precision", async () => {
  const { wire, request } = fixture();
  const amount = (1n << 64n) - 1n;
  const data = Uint8Array.from(wire.message.instructions[0]!.data);
  const view = new DataView(data.buffer);
  for (const offset of [2, 10, 18, 26, 34]) view.setBigUint64(offset, amount, true);
  wire.message.instructions[0]!.data = Array.from(data);
  mockResponse(wire);
  const quote = await createMainnetPropAmmRfqProvider(rfqUrl).quoteExactIn({ ...request, amountIn: amount });
  expect(quote.terms).toEqual({ side: "buy", baseAmount: amount, quoteAmount: amount, expiryMs: amount, nonce: amount });
  expect(vi.mocked(fetch).mock.calls[0]![1]?.body).toContain('"amount":18446744073709551615,');
});

it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe or nonpositive JSON output %s", async (amount) => {
  const { wire, request } = fixture();
  wire.estimated_quote.base_amount = amount;
  mockResponse(wire);
  await expect(createMainnetPropAmmRfqProvider(rfqUrl).quoteExactIn(request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
});

it.each(["program", "config", "user", "base mint", "quote mint"] as const)("rejects substituted %s", async (field) => {
  const { wire, request } = fixture();
  const index = { program: 0, config: 5, user: 2, "base mint": 1, "quote mint": 4 }[field]!;
  wire.message.account_keys[index] = Array.from(new Uint8Array(32).fill(99));
  mockResponse(wire);
  await expect(createMainnetPropAmmRfqProvider(rfqUrl).quoteExactIn(request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
});

it.each(["account index", "byte", "length", "side", "input"])("rejects an invalid native %s", async (field) => {
  const { wire, request } = fixture();
  const instruction = wire.message.instructions[0]!;
  if (field === "account index") instruction.accounts[0] = 255;
  if (field === "byte") instruction.data[0] = 258;
  if (field === "length") instruction.data.pop();
  if (field === "side") instruction.data[1] = 1;
  if (field === "input") instruction.data[34] = instruction.data[34]! ^ 1;
  mockResponse(wire);
  await expect(createMainnetPropAmmRfqProvider(rfqUrl).quoteExactIn(request)).rejects.toMatchObject({ code: "INVALID_RFQ" });
});

it("propagates HTTP errors without retries", async () => {
  const { request } = fixture();
  mockResponse({ error: "unavailable" }, 503);
  await expect(createMainnetPropAmmRfqProvider(rfqUrl).quoteExactIn(request)).rejects.toThrow("RFQ HTTP 503");
  expect(fetch).toHaveBeenCalledOnce();
});
