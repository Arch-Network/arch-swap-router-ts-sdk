import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET_AHYPE_USD as market } from "../../src/index.js";
import { decodeAddress, deriveAddress, decodeMint, decodeTokenAccount } from "../../src/utils.js";
import capture from "../fixtures/ahype-usd/deployment.json" with { type: "json" };
import { nativeTransaction } from "../fixtures/aeth-usd/transactions.js";

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(capture.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

it("binds aHYPE's decimals, vault and treasury identities to captured public accounts", () => {
  expect(Object.isFrozen(market)).toBe(true);
  const { mint, baseVault, bridgeAsset } = capture.accounts;
  expect(mint.address).toBe(market.baseMint);
  expect(mint.owner).toBe(market.tokenProgramId);
  expect(decodeMint(hex.decode(mint.data_hex)).decimals).toBe(market.baseDecimals);
  expect(market.baseDecimals).toBe(9);
  expect(baseVault.owner).toBe(market.tokenProgramId);
  expect(baseVault.address).toBe(deriveAddress(market.programId, "vault", decodeAddress(market.config), decodeAddress(market.baseMint)));
  expect(baseVault.address).toBe(market.baseVault);
  expect(decodeTokenAccount(hex.decode(baseVault.data_hex))).toMatchObject({ mint: market.baseMint, owner: market.config });
  const asset = hex.decode(bridgeAsset.data_hex);
  expect(bridgeAsset.owner).toBe(market.bridgeProgramId);
  expect(bridgeAsset.address).toBe(deriveAddress(market.bridgeProgramId, "asset", decodeAddress(market.baseMint)));
  expect(asset[0]).toBe(11);
  expect(base58.encode(asset.subarray(2, 34))).toBe(market.baseMint);
  expect(asset[34]).toBe(market.baseDecimals);
  expect(asset[44]).toBe(1);
  expect(base58.encode(asset.subarray(45, 77))).toBe(market.treasuryAuthority);
  expect(base58.encode(hex.decode(mint.data_hex).subarray(4, 36))).toBe(deriveAddress(market.bridgeProgramId, "mint-authority", decodeAddress(market.baseMint)));
});

it.each(capture.cases)("replays the captured, unmodified aHYPE $side packet", async fixture => {
  const transaction = nativeTransaction(fixture.transaction_hex);
  const source = { getAccounts: vi.fn(async () => { throw new Error("Unexpected account read"); }) };
  const authorization = "treasury_authorization" in fixture ? fixture.treasury_authorization : undefined;
  const provider = { quoteExactIn: vi.fn(async () => ({ transaction, quoteId: `captured-hype-${fixture.side}`,
    expiresAtMs: BigInt(fixture.expires_at_ms), estimatedAmountOut: BigInt(fixture.estimated_amount_out),
    ...(authorization ? { treasuryAuthorization: { version: 1 as const,
      minAmountIn: BigInt(authorization.min_amount_in), maxAmountIn: BigInt(authorization.max_amount_in) } } : {}) })) };
  const client = createRouterClient({ network: "mainnet", source, directRfqQuoteProvider: provider });
  const quote = await client.quoteExactIn({ inputMint: fixture.input_mint, outputMint: fixture.output_mint,
    amountIn: BigInt(fixture.amount_in), slippageBps: 100, user: capture.user, deadlineMs: fixture.expires_at_ms });
  expect(quote.hops.map(hop => hop.kind)).toEqual([fixture.side === "buy" ? "treasuryMint" : "propamm"]);
  expect(quote.estimatedAmountOut).toBe(BigInt(fixture.estimated_amount_out));
  expect(hex.encode(TransactionUtil.serialize(transaction))).toBe(fixture.transaction_hex);
  expect(source.getAccounts).not.toHaveBeenCalled();
  expect(provider.quoteExactIn).toHaveBeenCalledOnce();
});
