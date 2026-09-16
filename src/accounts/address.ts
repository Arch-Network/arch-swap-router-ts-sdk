import type { Pubkey } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { RouterSdkError } from "../errors/index.js";
import type { Address } from "../types.js";

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
