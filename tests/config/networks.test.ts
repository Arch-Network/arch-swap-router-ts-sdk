import { bytesToHex, encodeU16LE, hexToBytes } from "@arch-network/arch-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { MAINNET, MAINNET_MINTS, MAINNET_VENUES, NETWORKS, TESTNET } from "../../src/index.js";
import { decodeAddress, deriveAddress, deriveAssociatedTokenAddress, deriveProgramAddress } from "../../src/utils.js";

// The mainnet-v2 deployment record as lowercase hex: program ids as transcribed in arch-prime's
// registry/mainnet.ts, accounts from the 2026-10-15 snapshot (tests/fixtures/mainnet-v2/README.md).
const REGISTRY = {
  router: "a1ef55dc1509784c6c9228ac602d411f762a4fd857df8855a1813fc303afe690",
  vaults: "a1bf14cb9e197c446e0b10a9a732524f89dd2b13bd4c3dbd6b5ddcda242178e5",
  clamm: "948fc4f4794c9fff7d249114f90176178c483f219b9f42a5d42ab3eb21d23b05",
  whirlpoolsConfig: "47fbd6aee7aa0408c553d2d97d2801b3e8c56573afb006348fe98a641af7f8be",
  pool: "98562c44288c3f2e4f5ee0fb8db34070907f79b1c42a86e1223dafa6e6cad58d",
  propamm: "4022dec7e57f757682712b45ddf13a8f324710f4637cefc0ebacc6343caab24c",
  propammConfig: "45c0e785edb21a9a064146a891a44c4b37594e481a61d1cc586bf8edcbc5144e",
  primeBtcVault: "b9c7536cea2e4ce91e1c3b5a2e8575b0254bbc112686ec2c60edbd7509579d43",
  primeUsdVault: "83292e519e8569c4d10d5f80bc192d8ceb7a87ef1a78c218e0bbb24c69ccfa83",
  BTC: "5b29d2ff08829791698237a6d056ec9fab29187072819b7bf7a43e431f027f18",
  USD: "b8586267326264db356ca4c92b61dee74b4510cb95488897191d18520b3b18a4",
  primeBTC: "9e928ffe139436e2baabb05317c69ed5eb2676646f8bd2d65e2faae6a8e3867c",
  primeUSD: "a5a8683f428935ac46055c8708e95f3c9c139639419015a9702441b19ed81b04",
} as const;
// The pool account's tick spacing (offset 41) in the same snapshot.
const POOL_TICK_SPACING = 64;

const hexOf = (address: string) => bytesToHex(decodeAddress(address));

describe("public entry", () => {
  it("exports each network's program ids", () => {
    expect(NETWORKS.mainnet.programs).toBe(MAINNET);
    expect(NETWORKS.testnet.programs).toBe(TESTNET);
    for (const { programs, propamm } of Object.values(NETWORKS)) {
      for (const id of [programs.routerProgramId, programs.vaultProgramId, programs.clammProgramId, propamm.programId]) {
        expect(decodeAddress(id)).toHaveLength(32);
      }
    }
  });
});

describe("mainnet-v2 deployment", () => {
  const { propamm } = NETWORKS.mainnet;

  it("matches arch-prime's mainnet-v2 registry", () => {
    expect([
      MAINNET.routerProgramId, MAINNET.vaultProgramId, MAINNET.clammProgramId, MAINNET_VENUES.clamm.address,
      propamm.programId, propamm.config, MAINNET_VENUES.btcVault.address, MAINNET_VENUES.usdVault.address,
      MAINNET_MINTS.aBTC, MAINNET_MINTS.aUSD, MAINNET_MINTS.primeBTC, MAINNET_MINTS.primeUSD,
    ].map(hexOf)).toEqual([
      REGISTRY.router, REGISTRY.vaults, REGISTRY.clamm, REGISTRY.pool,
      REGISTRY.propamm, REGISTRY.propammConfig, REGISTRY.primeBtcVault, REGISTRY.primeUsdVault,
      REGISTRY.BTC, REGISTRY.USD, REGISTRY.primeBTC, REGISTRY.primeUSD,
    ]);
    expect(propamm).toMatchObject({ baseMint: MAINNET_MINTS.aBTC, quoteMint: MAINNET_MINTS.aUSD });
  });

  it("derives the vaults from their share mints and the pool with BTC as token A", () => {
    for (const venue of [MAINNET_VENUES.btcVault, MAINNET_VENUES.usdVault]) {
      expect(deriveAddress(MAINNET.vaultProgramId, "vault", decodeAddress(venue.shareMint))).toBe(venue.address);
    }
    const { clamm } = MAINNET_VENUES;
    expect(clamm).toMatchObject({ tokenMintA: MAINNET_MINTS.aBTC, tokenMintB: MAINNET_MINTS.aUSD });
    const seeds = [decodeAddress(clamm.tokenMintA), decodeAddress(clamm.tokenMintB), encodeU16LE(POOL_TICK_SPACING)];
    expect(hexOf(deriveAddress(MAINNET.clammProgramId, "whirlpool", hexToBytes(REGISTRY.whirlpoolsConfig), ...seeds)))
      .toBe(REGISTRY.pool);
  });
});

describe("without a global Buffer", () => {
  const saved = globalThis.Buffer;
  afterEach(() => { globalThis.Buffer = saved; });

  it("derives program and associated token addresses", () => {
    const expected = {
      vault: MAINNET_VENUES.btcVault.address,
      pda: deriveProgramAddress([new TextEncoder().encode("vault"), decodeAddress(MAINNET_MINTS.primeBTC)], MAINNET.vaultProgramId),
      ata: deriveAssociatedTokenAddress(MAINNET.routerProgramId, MAINNET_MINTS.aUSD, MAINNET),
    };
    Reflect.deleteProperty(globalThis, "Buffer");
    expect(globalThis.Buffer).toBeUndefined();
    expect(deriveAddress(MAINNET.vaultProgramId, "vault", decodeAddress(MAINNET_MINTS.primeBTC))).toBe(expected.vault);
    expect(deriveProgramAddress([new TextEncoder().encode("vault"), decodeAddress(MAINNET_MINTS.primeBTC)], MAINNET.vaultProgramId))
      .toEqual(expected.pda);
    expect(deriveAssociatedTokenAddress(MAINNET.routerProgramId, MAINNET_MINTS.aUSD, MAINNET)).toBe(expected.ata);
  });
});
