import { vi } from "vitest";
import type { AccountInfoResult } from "@arch-network/arch-sdk";
import { createRouterClient } from "../../src/index.js";
import { NETWORKS, TESTNET, type Network } from "../../src/config/networks.js";
import { decodeAddress, deriveAddress, U64_MAX } from "../../src/utils.js";
import { namedFixture } from "../transactions/fixtures.js";
import native from "./clamm/native.json" with { type: "json" };
import vaultContract from "./vault/contract.json" with { type: "json" };

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
const info = (data: Uint8Array, owner: string = TESTNET.clammProgramId): AccountInfoResult => ({
  data, owner: decodeAddress(owner), lamports: 1, utxo: "fixture:0", is_executable: false,
});
const setU64 = (data: Uint8Array, offset: number, value: bigint) => new DataView(data.buffer).setBigUint64(offset, value, true);
export const now = 1_800_000_000n;

/** Synthetic mint/vault inputs use the independent Rust layouts and fixture identities. */
export function setup(poolData = bytes(native.cases[0]!.pool), network: Network = "testnet") {
  const { programs, mints, venues } = NETWORKS[network];
  const accounts = new Map<string, AccountInfoResult | null>();
  if (venues.clamm) accounts.set(venues.clamm.address, info(poolData, programs.clammProgramId));
  for (const usd of [false, true]) {
    const venue = usd ? venues.usdVault : venues.btcVault;
    const reserveAddress = deriveAddress(programs.vaultProgramId, "reserve", decodeAddress(venue.shareMint));
    const escrow = deriveAddress(programs.vaultProgramId, "escrow", decodeAddress(venue.shareMint));
    const vault = bytes(vaultContract.vault);
    setU64(vault, 8, 0n); setU64(vault, 16, now); setU64(vault, 24, U64_MAX);
    setU64(vault, 40, 42n); setU64(vault, 48, 42n);
    vault[56] = 1; setU64(vault, 64, 100n); vault[393] = 0;
    vault.set([255, 255, 255], 394);
    for (const offset of [201, 233]) vault.set(new Uint8Array(32).fill(usd ? 42 : 41), offset);
    for (const [offset, key] of [[265, venue.assetMint], [297, venue.shareMint], [329, reserveAddress], [361, escrow]] as const) {
      vault.set(decodeAddress(key), offset);
    }
    accounts.set(venue.address, info(vault, programs.vaultProgramId));
    for (const [mint, supply] of [[venue.assetMint, 1_000_000_000n], [venue.shareMint, 1_000_000_000_000n]] as const) {
      const data = new Uint8Array(82); data[0] = 1; data[45] = 1; data[44] = network === "mainnet" && usd ? 6 : 8;
      data.set(decodeAddress(venue.address), 4); setU64(data, 36, supply);
      accounts.set(mint, info(data, programs.tokenProgramId));
    }
    const reserve = new Uint8Array(165); reserve[108] = 1;
    reserve.set(decodeAddress(venue.assetMint)); reserve.set(decodeAddress(venue.address), 32);
    setU64(reserve, 64, 1_000_000_000n);
    accounts.set(reserveAddress, info(reserve, programs.tokenProgramId));
  }
  const source = { getAccounts: vi.fn(async (keys: readonly string[]) => keys.map((key) => accounts.get(key) ?? null)) };
  const request = {
    inputMint: mints.aBTC as string, outputMint: mints.aUSD as string,
    amountIn: 1_000_000_000n, slippageBps: 50, deadlineMs: 1_800_000_000_123,
    user: namedFixture("direct-mint-btc").user,
  };
  return { accounts, source, request, client: createRouterClient({ source, network }) };
}
