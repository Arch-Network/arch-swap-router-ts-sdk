import { base58 } from "@scure/base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET_AETH_USD, MAINNET_AHYPE_USD, type DirectRfqQuote } from "../src/index.js";
import { NETWORKS } from "../src/config/networks.js";
import { compileRouterMessage, decodeAddress, deriveAddress, deriveProgramAddress } from "../src/utils.js";
import { setupComposableAeth } from "./fixtures/composable-aeth.js";
import capture from "./fixtures/treasury-sells/ahype-usd.json" with { type: "json" };
import clock from "./fixtures/aeth-usd/transactions.json" with { type: "json" };

const config = NETWORKS.mainnet;
const outputs = [
  [config.mints.aUSD, ["treasuryMint"]],
  [config.mints.primeUSD, ["treasuryMint", "vaultMint"]],
  [config.mints.aBTC, ["treasuryMint", "clamm"]],
  [config.mints.primeBTC, ["treasuryMint", "clamm", "vaultMint"]],
] as const;
const markets = [MAINNET_AETH_USD, MAINNET_AHYPE_USD];

function setup(market: (typeof markets)[number] = MAINNET_AHYPE_USD, outputMint: string = config.mints.primeBTC) {
  const state = setupComposableAeth();
  const original = capture.response.message;
  const user = base58.encode(Uint8Array.from(original.account_keys[0]!));
  const ata = (mint: string) => deriveProgramAddress([
    decodeAddress(user), decodeAddress(market.tokenProgramId), decodeAddress(mint),
  ], market.associatedTokenProgramId)[0];
  const replacements = new Map([
    [MAINNET_AHYPE_USD.baseMint, market.baseMint],
    [MAINNET_AHYPE_USD.baseVault, market.baseVault],
    [ata(MAINNET_AHYPE_USD.baseMint), ata(market.baseMint)],
  ]);
  const amountIn = BigInt(capture.request.amount);
  const request = { ...state.request, inputMint: market.baseMint, outputMint, amountIn, user };
  const rfq: DirectRfqQuote = {
    transaction: { version: 0, signatures: [], message: {
      header: { ...original.header },
      account_keys: original.account_keys.map(key => decodeAddress(replacements.get(base58.encode(Uint8Array.from(key))) ?? base58.encode(Uint8Array.from(key)))),
      recent_blockhash: Uint8Array.from(original.recent_blockhash),
      instructions: original.instructions.map(ix => ({ ...ix, accounts: [...ix.accounts], data: Uint8Array.from(ix.data) })),
    } },
    quoteId: "treasury-sell",
    expiresAtMs: BigInt(clock.now_ms + 30_000),
    estimatedAmountOut: BigInt(capture.response.estimated_quote.quote_amount),
    treasuryAuthorization: { version: 1, minAmountIn: amountIn * 9950n / 10000n, maxAmountIn: amountIn * 10050n / 10000n },
  };
  const provider = { quoteExactIn: vi.fn(async () => rfq) };
  return { ...state, request, rfq, provider, client: createRouterClient({ ...state.options, directRfqQuoteProvider: provider }) };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(clock.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

it.each(markets)("composes treasury sells from $baseMint into each core asset", async market => {
  for (const [output, kinds] of outputs) {
    const state = setup(market, output);
    const quote = await state.client.quoteExactIn(state.request);
    expect(quote.hops.map(hop => hop.kind)).toEqual(kinds);
    expect(state.provider.quoteExactIn).toHaveBeenCalledOnce();
    expect(state.propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
    const router = quote.instructions.at(-1)!;
    const venue = 2 + 2 * (kinds.length + 1);
    expect(base58.encode(router.accounts[venue + 3]!.pubkey)).toBe(deriveAddress(market.bridgeProgramId, "asset", decodeAddress(market.quoteMint)));
    expect(base58.encode(router.accounts[venue + 7]!.pubkey)).toBe(market.baseVault);
    expect(router.accounts[4]!.is_writable).toBe(true);
    const data = new DataView(router.data.buffer, router.data.byteOffset, router.data.byteLength);
    expect(router.data[26]).toBe(4);
    expect(data.getBigUint64(59, true)).toBe(state.request.amountIn);
    expect(data.getBigUint64(67, true)).toBe(state.rfq.estimatedAmountOut);
    const message = compileRouterMessage(quote.instructions, state.request.user, new Uint8Array(32));
    expect(message.header).toMatchObject({ num_required_signatures: 2, num_readonly_signed_accounts: 0 });
    expect(message.account_keys).toHaveLength(new Set(message.account_keys.map(base58.encode)).size);
  }
});

it.each(["missing authorization", "wrong payment vault", "wrong minted asset", "wrong amount", "wrong recipient", "expired", "bounds exclude input"])("rejects treasury sells with %s", async field => {
  const state = setup();
  const message = state.rfq.transaction.message;
  const [payment, mint] = message.instructions;
  if (field === "missing authorization") delete (state.rfq as { treasuryAuthorization?: unknown }).treasuryAuthorization;
  if (field === "wrong payment vault") message.account_keys[payment!.accounts[1]!] = decodeAddress(MAINNET_AHYPE_USD.quoteVault);
  if (field === "wrong minted asset") message.account_keys[mint!.accounts[4]!] = decodeAddress(MAINNET_AHYPE_USD.baseMint);
  if (field === "wrong amount") payment!.data[1] ^= 1;
  if (field === "wrong recipient") mint!.data[41] ^= 1;
  if (field === "expired") Object.assign(state.rfq, { expiresAtMs: BigInt(clock.now_ms) });
  if (field === "bounds exclude input") Object.assign(state.rfq.treasuryAuthorization!, { minAmountIn: state.request.amountIn + 1n });
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: field === "expired" ? "RFQ_EXPIRED" : "INVALID_RFQ" });
});

it("keeps aETH and aHYPE conversions outside the one-quote route graph", async () => {
  const state = setup(MAINNET_AHYPE_USD, MAINNET_AETH_USD.baseMint);
  await expect(state.client.quoteExactIn(state.request)).rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
  expect(state.provider.quoteExactIn).not.toHaveBeenCalled();
});
