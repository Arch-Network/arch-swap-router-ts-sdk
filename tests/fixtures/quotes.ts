import { vi } from "vitest";
import type { AccountInfoResult } from "@arch-network/arch-sdk";
import { createRouterClient, TESTNET_MINTS } from "../../src/index.js";
import { TESTNET, TESTNET_VENUES } from "../../src/config/networks.js";
import { decodeAddress, U64_MAX } from "../../src/utils.js";
import { buildInput, namedFixture } from "../transactions/fixtures.js";
import native from "./clamm/native.json" with { type: "json" };
import vaultContract from "./vault/contract.json" with { type: "json" };

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
const info = (data: Uint8Array, owner: string = TESTNET.clammProgramId): AccountInfoResult => ({
  data, owner: decodeAddress(owner), lamports: 1, utxo: "fixture:0", is_executable: false,
});
const setU64 = (data: Uint8Array, offset: number, value: bigint) => new DataView(data.buffer).setBigUint64(offset, value, true);
const poolAddress = TESTNET_VENUES.clamm.address;
export const now = 1_800_000_000n;

/** Synthetic mint/vault inputs use the independent Rust layouts and fixture identities. */
export function setup(poolData = bytes(native.cases[0]!.pool)) {
  const accounts = new Map<string, AccountInfoResult | null>([[poolAddress, info(poolData)]]);
  for (const usd of [false, true]) {
    const venue = usd ? TESTNET_VENUES.usdVault : TESTNET_VENUES.btcVault;
    const step = buildInput(namedFixture(`direct-redeem-${usd ? "usd" : "btc"}`)).steps[0]!;
    if (step.kind !== "vaultRedeem") throw new Error("Expected redeem fixture");
    const vault = bytes(vaultContract.vault);
    setU64(vault, 8, 0n); setU64(vault, 16, now); setU64(vault, 24, U64_MAX);
    setU64(vault, 40, 42n); setU64(vault, 48, 42n);
    vault[56] = 1; setU64(vault, 64, 100n); vault[393] = 0;
    vault.set([255, 255, 255], 394);
    for (const offset of [201, 233]) vault.set(new Uint8Array(32).fill(usd ? 42 : 41), offset);
    for (const [offset, key] of [[265, venue.assetMint], [297, venue.shareMint], [329, step.reserve], [361, step.escrow]] as const) {
      vault.set(decodeAddress(key), offset);
    }
    accounts.set(venue.address, info(vault, TESTNET.vaultProgramId));
    for (const [mint, supply] of [[venue.assetMint, 1_000_000_000n], [venue.shareMint, 1_000_000_000_000n]] as const) {
      const data = new Uint8Array(82); data[0] = 1; data[45] = 1; data[44] = 8;
      data.set(decodeAddress(venue.address), 4); setU64(data, 36, supply);
      accounts.set(mint, info(data, TESTNET.tokenProgramId));
    }
    const reserve = new Uint8Array(165); reserve[108] = 1;
    reserve.set(decodeAddress(venue.assetMint)); reserve.set(decodeAddress(venue.address), 32);
    setU64(reserve, 64, 1_000_000_000n);
    accounts.set(step.reserve, info(reserve, TESTNET.tokenProgramId));
  }
  const source = { getAccounts: vi.fn(async (keys: readonly string[]) => keys.map((key) => accounts.get(key) ?? null)) };
  const request = {
    inputMint: TESTNET_MINTS.aBTC as string, outputMint: TESTNET_MINTS.aUSD as string,
    amountIn: 1_000_000_000n, slippageBps: 50, deadlineMs: 1_800_000_000_123,
    user: namedFixture("direct-mint-btc").user,
  };
  return { accounts, source, request, client: createRouterClient({ source }) };
}

