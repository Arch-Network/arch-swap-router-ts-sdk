import { describe, expect, it } from "vitest";
import { decodeAddress } from "../../src/accounts/address.js";
import {
  deriveAssociatedTokenAddress,
  deriveProgramAddress,
} from "../../src/accounts/pda.js";
import { TESTNET, TESTNET_MINTS } from "../../src/config/testnet.js";
import { RouterSdkError } from "../../src/errors/index.js";

// Expected keys and bumps come from arch-swap-router/tests/account_validation.rs.
const operator = "Gezw1yUcDjFhKQoJw6zq7nRJTc1MKhcUipNsUfrVpJKF";

describe("Arch SDK derivation compatibility", () => {
  it.each([
    [TESTNET_MINTS.primeBTC, "48iL9oYHb14NazPBFN3mHjemCSLj5Tgxf9a9N3taww12"],
    [TESTNET_MINTS.primeUSD, "6fitWMWz7VYdQbhquSGwM1JPR2yCYn5iupMWUDYCfC2a"],
  ])("matches the Rust ATA fixture for %s", (mint, expected) => {
    expect(deriveAssociatedTokenAddress(operator, mint, TESTNET)).toBe(expected);
  });

  it.each([
    ["vault", TESTNET_MINTS.primeBTC, "6H4kmh2TKpkXH5sVCMMEThVZyZSXrsvPEpipY8aFoDF7"],
    ["reserve", TESTNET_MINTS.primeBTC, "EPvrvCfoQ2LPYX1AUf8yxM28WWXbJJdNWCazBz1VyYdq"],
    ["escrow", TESTNET_MINTS.primeBTC, "Gy7gccftxTxCbyDDmEMU2Lzddyw7jbiq65LvEfEHCSjm"],
    ["vault", TESTNET_MINTS.primeUSD, "CBiMudmQp9i1ZSMRApZTBAaAzdbRnDsHTaoN2YnXqBxC"],
    ["reserve", TESTNET_MINTS.primeUSD, "AnKv8wEGcHxCqqGHTdv8AYf1t43JRhZNRGxNYi6oT2bp"],
    ["escrow", TESTNET_MINTS.primeUSD, "3gRMfpECtvVbih8SCZfgJkMjF6HuGnwa4Zooo2j8Vcx7"],
  ])("matches the Rust %s PDA for %s", (seed, mint, expected) => {
    expect(
      deriveProgramAddress(
        [new TextEncoder().encode(seed), decodeAddress(mint)],
        TESTNET.vaultProgramId,
      ),
    ).toEqual([expected, 255]);
  });
});

describe("address decoding", () => {
  it("preserves leading zero bytes", () => {
    expect(decodeAddress(TESTNET.systemProgramId)).toEqual(new Uint8Array(32));
  });

  it.each(["0OIl", "", "1".repeat(31), "1".repeat(33)])(
    "rejects invalid public key %j",
    (address) => {
      expect(() => decodeAddress(address)).toThrow(RouterSdkError);
      expect(() => decodeAddress(address)).toThrow(
        expect.objectContaining({ code: "INVALID_ADDRESS" }),
      );
    },
  );
});
