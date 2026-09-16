import { PubkeyUtil } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { TESTNET } from "../config/testnet.js";
import type { Address } from "../types.js";
import { decodeAddress } from "./address.js";

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

export function deriveAssociatedTokenAddress(
  owner: Address,
  mint: Address,
): Address {
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
