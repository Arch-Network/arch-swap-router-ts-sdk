import { base58, hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { MAINNET_AETH_USD as eth } from "../../src/config/aeth-usd.js";
import { MAINNET, MAINNET_MINTS, MAINNET_VENUES, NETWORKS } from "../../src/config/networks.js";
import { decodePool } from "../../src/clamm.js";
import { decodeAddress, decodeMint, deriveAddress } from "../../src/utils.js";
import { decodeVault } from "../../src/vault.js";
import snapshot from "../fixtures/mainnet-v2/accounts.json" with { type: "json" };

const accounts = snapshot.accounts;

describe("mainnet-v2 deployment account snapshots", () => {
  it("uses the on-chain mints and their actual decimals", () => {
    for (const [symbol, decimals] of [["aBTC", 8], ["aUSD", 6], ["primeBTC", 8], ["primeUSD", 6]] as const) {
      const account = accounts[symbol];
      expect(MAINNET_MINTS[symbol]).toBe(account.address);
      expect(account.owner).toBe(MAINNET.tokenProgramId);
      expect(decodeMint(hex.decode(account.data_hex)).decimals).toBe(decimals);
    }
    expect(eth.baseMint).toBe(accounts.aETH.address);
    expect(accounts.aETH.owner).toBe(eth.tokenProgramId);
    expect(decodeMint(hex.decode(accounts.aETH.data_hex)).decimals).toBe(eth.baseDecimals);
    expect(eth.quoteMint).toBe(MAINNET_MINTS.aUSD);
  });

  it("uses the deployed BTC/USD CLAMM order", () => {
    expect(MAINNET_VENUES.clamm.address).toBe(accounts.clamm.address);
    expect(accounts.clamm.owner).toBe(MAINNET.clammProgramId);
    const pool = decodePool(hex.decode(accounts.clamm.data_hex));
    expect(pool).toMatchObject({ tokenMintA: MAINNET_MINTS.aBTC, tokenMintB: MAINNET_MINTS.aUSD });
    expect(MAINNET_VENUES.clamm).toMatchObject({ tokenMintA: pool.tokenMintA, tokenMintB: pool.tokenMintB });
  });

  it.each(["btcVault", "usdVault"] as const)("binds %s to its native asset, share and reserve", name => {
    const account = accounts[name], venue = MAINNET_VENUES[name];
    expect(venue.address).toBe(account.address);
    expect(account.owner).toBe(MAINNET.vaultProgramId);
    const vault = decodeVault(hex.decode(account.data_hex));
    expect(vault).toMatchObject({ assetMint: venue.assetMint, shareMint: venue.shareMint });
    expect(deriveAddress(MAINNET.vaultProgramId, "vault", decodeAddress(vault.shareMint))).toBe(venue.address);
    expect(deriveAddress(MAINNET.vaultProgramId, "reserve", decodeAddress(vault.shareMint))).toBe(vault.reserve);
  });

  it("shares the verified PropAMM config across the BTC and ETH markets", () => {
    const deployment = NETWORKS.mainnet.propammMarkets[0]!;
    expect(deployment.config).toBe(accounts.propammConfig.address);
    expect(deployment.programId).toBe(accounts.propammConfig.owner);
    expect(eth.config).toBe(deployment.config);
    expect(eth.programId).toBe(deployment.programId);
    const config = hex.decode(accounts.propammConfig.data_hex);
    expect(base58.encode(config.slice(41, 73))).toBe(eth.quoteSigner);
    expect(deriveAddress(deployment.programId, "config_v2", config.slice(73, 105))).toBe(deployment.config);
  });
});
