import { bytesToHex, encodeU16LE, hexToBytes } from "@arch-network/arch-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as NetworksModule from "../../src/config/networks.js";
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

describe("testnet-v2 deployment", async () => {
  // tests/setup.ts substitutes the recorded deployment for fixture replay; read the shipped constants directly.
  const { NETWORKS: SHIPPED } = await vi.importActual<typeof NetworksModule>("../../src/config/networks.js");
  const { programs, mints, venues, propamm } = SHIPPED.testnet;
  // arch-prime registry/testnet.ts (hex) and test/fixtures/registry/testnet-v2-accounts.json `addresses`.
  const TESTNET_REGISTRY = {
    vaults: "8f536a09d71acf3456c0b3064457a5d44d3cf1da64e9798c564b93bec180cad3",
    clamm: "0e772da22661e26a03badc7d46c4120572c50d579b2ccdf06d65806e60870a53",
    whirlpoolsConfig: "55ed487bc738c1e0220a512727cc26ee90bb3b247027764fffcd6b2e083e2969",
    pool: "360ae6d23a22d4de2bf568b64d77371cce1c5325c219c39aa4b014f41561cb51",
    propamm: "2b060c7bf7948c4b94daa7615951816448dd15abb062918aaf887cfad1b7acbd",
    propammConfig: "d07399c98f269fe3529bb567231833ca6cc72b4a36587e6b1a781a6bfa205625",
    BTC: "8eaa71af851ce2e33e062f648a72f072ea3ff7e4734c898d35213f7f75b2f495",
    USD: "b777dde3980c8269fbab860d921deb2a155f9e423bc4686b5cf7c731d899073c",
    primeBTC: "0e0c872533ab069fc099e068faa9f46894e467901f446d7d6ec5a92e5f8c2f6f",
    primeUSD: "7168649ad19ed0dc1918870b2a98eaca0bf1398d4847ff8eaab06a202da91884",
  } as const;

  it("matches the testnet-v2 deployment record", () => {
    expect([
      programs.vaultProgramId, programs.clammProgramId, venues.clamm.address, propamm.programId, propamm.config,
      mints.aBTC, mints.aUSD, mints.primeBTC, mints.primeUSD,
    ].map(hexOf)).toEqual([
      TESTNET_REGISTRY.vaults, TESTNET_REGISTRY.clamm, TESTNET_REGISTRY.pool, TESTNET_REGISTRY.propamm,
      TESTNET_REGISTRY.propammConfig, TESTNET_REGISTRY.BTC, TESTNET_REGISTRY.USD, TESTNET_REGISTRY.primeBTC,
      TESTNET_REGISTRY.primeUSD,
    ]);
    // arch-infrastructure testnet-v2 stage outputs `programs["swap-router"].program_id`; arch-prime's registry has none.
    expect(programs.routerProgramId).toBe("HmJrj8ZFkxFBYB77EAkjAWk7phoUSyQ8rXhCxTHMv3vD");
  });

  it("derives the vaults, the pool with BTC as token A and the PropAMM config", () => {
    for (const venue of [venues.btcVault, venues.usdVault]) {
      expect(deriveAddress(programs.vaultProgramId, "vault", decodeAddress(venue.shareMint))).toBe(venue.address);
    }
    expect(venues.clamm).toMatchObject({ tokenMintA: mints.aBTC, tokenMintB: mints.aUSD });
    const seeds = [decodeAddress(mints.aBTC), decodeAddress(mints.aUSD), encodeU16LE(POOL_TICK_SPACING)];
    expect(hexOf(deriveAddress(programs.clammProgramId, "whirlpool", hexToBytes(TESTNET_REGISTRY.whirlpoolsConfig), ...seeds)))
      .toBe(TESTNET_REGISTRY.pool);
    // config_id read from the config account (offset 73) on testnet RPC, 2026-10-29.
    expect(deriveAddress(propamm.programId, "config_v2", decodeAddress("BEKdPfHdwC9ygc1Tb3AcmUsAuVTBSeK8U2R6H1rMJRXG")))
      .toBe(propamm.config);
    expect(propamm).toMatchObject({ baseMint: mints.aBTC, quoteMint: mints.aUSD });
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
