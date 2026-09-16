import { PubkeyUtil, type AccountMeta, type Pubkey } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { TESTNET } from "./config/testnet.js";
import { RouterSdkError } from "./errors.js";
import type { Address } from "./types.js";

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

export function assertIntegerRange(
  value: bigint,
  field: string,
  min: bigint,
  max: bigint,
): void {
  // SDK integer writers truncate out-of-range values; reject before writing.
  if (typeof value !== "bigint" || value < min || value > max) {
    throw new RouterSdkError(
      "INVALID_INSTRUCTION",
      `${field} must be a bigint in the range ${min}..${max}.`,
    );
  }
}

export function decodeAddress(address: Address): Pubkey {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(address);
  } catch (cause) {
    throw new RouterSdkError(
      "INVALID_ADDRESS",
      "Address must be a base58-encoded public key.",
      { cause },
    );
  }
  if (bytes.length !== 32) {
    throw new RouterSdkError(
      "INVALID_ADDRESS",
      "Address must decode to exactly 32 bytes.",
    );
  }
  return bytes;
}

export function account(pubkey: Address, is_writable = false, is_signer = false): AccountMeta {
  return { pubkey: decodeAddress(pubkey), is_writable, is_signer };
}

export function deriveProgramAddress(
  seeds: readonly Uint8Array[],
  programId: Address,
): readonly [Address, number] {
  const [address, bump] = PubkeyUtil.findProgramAddress(
    [...seeds],
    decodeAddress(programId),
  );
  return [base58.encode(address), bump];
}

export function deriveAssociatedTokenAddress(owner: Address, mint: Address): Address {
  return base58.encode(
    PubkeyUtil.getAssociatedTokenAddress(
      decodeAddress(mint),
      decodeAddress(owner),
      true, // Arch's 32-byte x-only keys do not pass the SDK's SEC1 curve guard.
      decodeAddress(TESTNET.tokenProgramId),
      decodeAddress(TESTNET.associatedTokenProgramId),
    ),
  );
}
