import type { AccountInfoResult } from "@arch-network/arch-sdk";
import { hex } from "@scure/base";
import { vi } from "vitest";
import { createRouterClient, MAINNET_AETH_USD as market,
  type DirectRfqQuote, type PropAmmQuote, type QuoteExactInRequest } from "../../src/index.js";
import { NETWORKS } from "../../src/config/networks.js";
import { decodeAddress, deriveAddress } from "../../src/utils.js";
import fixtures from "./aeth-usd/transactions.json" with { type: "json" };
import mainnet from "./mainnet-v2/accounts.json" with { type: "json" };
import { nativeTransaction } from "./aeth-usd/transactions.js";
import { setup as coreFixture } from "./quotes.js";

export const setU64 = (data: Uint8Array, offset: number, value: bigint) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset, value, true);

/** Native sell and Rust vault layouts, with mainnet identities and a captured pool.
 * Vault balances/prices and absent tick arrays are synthetic; no network is used. */
export function setupComposableAeth(outputMint: string = market.quoteMint) {
  const config = NETWORKS.mainnet;
  const fixture = fixtures.cases.find((fixture) => fixture.side === "sell")!;
  const request: QuoteExactInRequest = {
    inputMint: market.baseMint, outputMint, amountIn: BigInt(fixture.amount_in), slippageBps: 100,
    user: fixtures.user, deadlineMs: fixtures.now_ms + 60_000,
  };
  const rfq: DirectRfqQuote = {
    transaction: nativeTransaction(fixture.transaction_hex), quoteId: "native-aeth-sell",
    expiresAtMs: BigInt(fixture.expires_at_ms), estimatedAmountOut: BigInt(fixture.estimated_amount_out),
  };
  const core = coreFixture();
  const info = (data: Uint8Array, owner: string = config.programs.tokenProgramId): AccountInfoResult => ({
    owner: decodeAddress(owner), data, lamports: 1, utxo: "fixture:0", is_executable: false,
  });
  const accounts = new Map<string, AccountInfoResult>();
  for (const name of ["usdVault", "btcVault"] as const) {
    const venue = config.venues[name];
    const previous = NETWORKS.testnet.venues[name];
    const reserve = deriveAddress(config.programs.vaultProgramId, "reserve", decodeAddress(venue.shareMint));
    const vault = core.accounts.get(previous.address)!.data;
    for (const [offset, key] of [[265, venue.assetMint], [297, venue.shareMint], [329, reserve],
      [361, deriveAddress(config.programs.vaultProgramId, "escrow", decodeAddress(venue.shareMint))]] as const) {
      vault.set(decodeAddress(key), offset);
    }
    accounts.set(venue.address, info(vault, config.programs.vaultProgramId));
    for (const [oldMint, mint] of [[previous.assetMint, venue.assetMint], [previous.shareMint, venue.shareMint]] as const) {
      const data = core.accounts.get(oldMint)!.data;
      data[44] = name === "usdVault" ? 6 : 8;
      data.set(decodeAddress(venue.address), 4);
      accounts.set(mint, info(data));
    }
    const tokens = new Uint8Array(165);
    tokens[108] = 1; tokens.set(decodeAddress(venue.assetMint)); tokens.set(decodeAddress(venue.address), 32);
    setU64(tokens, 64, 1_000_000_000n);
    accounts.set(reserve, info(tokens));
  }
  const pool = mainnet.accounts.clamm;
  accounts.set(pool.address, info(hex.decode(pool.data_hex), pool.owner));
  const source = { getAccounts: vi.fn(async (keys: readonly string[]) => keys.map((key) => accounts.get(key) ?? null)) };
  const directRfqQuoteProvider = { quoteExactIn: vi.fn(async (_request: QuoteExactInRequest) => rfq) };
  const propAmmQuoteProvider = { quoteExactIn: vi.fn(async (): Promise<PropAmmQuote> => { throw new Error("Unexpected BTC/USD RFQ"); }) };
  const options = { source, network: "mainnet" as const, directRfqQuoteProvider, propAmmQuoteProvider, composableAethSells: true };
  return { request, rfq, source, accounts, directRfqQuoteProvider, propAmmQuoteProvider, options, client: createRouterClient(options) };
}
