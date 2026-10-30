import { base58ToBytes, bytesToBase58, bytesToHex, hexToBytes } from "@arch-network/arch-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient, MAINNET, MAINNET_MINTS, MAINNET_VENUES, type RouterDataSource } from "../src/index.js";
import snapshot from "./fixtures/mainnet-v2/accounts.json" with { type: "json" };

const recorded: Record<string, { readonly owner: string; readonly data: string }> = snapshot.accounts;
const source: RouterDataSource = {
  getAccounts: async (addresses) => addresses.map((address) => {
    const account = recorded[bytesToHex(base58ToBytes(address))];
    return account === undefined ? null : {
      owner: hexToBytes(account.owner), data: hexToBytes(account.data), lamports: 1, utxo: "", is_executable: false,
    };
  }),
};
const request = { amountIn: 1000n, slippageBps: 50, user: bytesToBase58(new Uint8Array(32).fill(0x42)) };

describe("mainnet-v2 snapshot replay", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshot.observedAt)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([MAINNET_VENUES.btcVault, MAINNET_VENUES.usdVault])("mints $shareMint shares through the router from the recorded vault", async (venue) => {
    const quote = await createRouterClient({ network: "mainnet", source }).quoteExactIn({
      ...request, inputMint: venue.assetMint, outputMint: venue.shareMint, deadlineMs: Date.now() + 30_000,
    });
    expect(quote.hops).toEqual([{
      kind: "vaultMint", inputMint: venue.assetMint, outputMint: venue.shareMint, amountIn: 1000n, estimatedAmountOut: 1_000_000n,
    }]);
    const instruction = quote.instructions.at(-1)!;
    expect(bytesToBase58(instruction.program_id)).toBe(MAINNET.routerProgramId);
    expect(instruction.accounts.map((meta) => bytesToBase58(meta.pubkey)))
      .toEqual(expect.arrayContaining([MAINNET.vaultProgramId, venue.address, venue.assetMint, venue.shareMint]));
  });

  it("swaps aBTC for aUSD on the recorded pool with BTC as token A", async () => {
    const quote = await createRouterClient({ network: "mainnet", source }).quoteExactIn({
      ...request, inputMint: MAINNET_MINTS.aBTC, outputMint: MAINNET_MINTS.aUSD, deadlineMs: Date.now() + 30_000,
    });
    expect(quote.hops).toEqual([expect.objectContaining({
      kind: "clamm", inputMint: MAINNET_MINTS.aBTC, outputMint: MAINNET_MINTS.aUSD, amountIn: 1000n, estimatedAmountOut: 815_082n,
    })]);
    const instruction = quote.instructions.at(-1)!;
    expect(bytesToBase58(instruction.program_id)).toBe(MAINNET.routerProgramId);
    // Route data byte 27 is the CLAMM step's aToB flag.
    expect(instruction.data[27]).toBe(1);
    expect(instruction.accounts.map((meta) => bytesToBase58(meta.pubkey)))
      .toEqual(expect.arrayContaining([MAINNET.clammProgramId, MAINNET_VENUES.clamm.address]));
  });
});
