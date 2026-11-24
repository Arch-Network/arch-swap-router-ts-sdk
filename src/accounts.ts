import { PubkeyUtil, type AccountInfoResult, type AccountMeta, type Pubkey } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { RouterSdkError } from "./errors.js";

/** Base58 public key; decoded and length-checked at the byte-conversion boundary. */
export type Address = string;

export interface RouterDataSource {
  /** Preserve request order; null means missing, while transport failures reject. */
  getAccounts(addresses: readonly Address[]): Promise<readonly (AccountInfoResult | null)[]>;
}

export type AccountMap = ReadonlyMap<Address, AccountInfoResult | null>;

export interface TokenProgramIds {
  readonly tokenProgramId: Address;
  readonly associatedTokenProgramId: Address;
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

export function deriveAddress(programId: Address, seed: string, ...seeds: Uint8Array[]): Address {
  return deriveProgramAddress([new TextEncoder().encode(seed), ...seeds], programId)[0];
}

export function deriveAssociatedTokenAddress(owner: Address, mint: Address, programs: TokenProgramIds): Address {
  return base58.encode(
    PubkeyUtil.getAssociatedTokenAddress(
      decodeAddress(mint),
      decodeAddress(owner),
      true, // Arch's 32-byte x-only keys do not pass the SDK's SEC1 curve guard.
      decodeAddress(programs.tokenProgramId),
      decodeAddress(programs.associatedTokenProgramId),
    ),
  );
}

async function readAccountBatch(source: RouterDataSource, keys: readonly Address[]) {
  const results = await source.getAccounts(keys);
  if (!Array.isArray(results) || results.length !== keys.length) {
    throw new RouterSdkError("INVALID_RESPONSE", "Account response must match the requested batch length.");
  }
  return results;
}

function validateAccount(info: AccountInfoResult | null | undefined, key: Address): AccountInfoResult | null {
  if (info !== null && (
    !info || !(info.data instanceof Uint8Array) || !(info.owner instanceof Uint8Array)
    || info.owner.length !== 32 || !Number.isInteger(info.lamports) || info.lamports < 0
    || typeof info.utxo !== "string" || typeof info.is_executable !== "boolean"
  )) {
    throw new RouterSdkError("INVALID_RESPONSE", `Malformed account response for ${key}.`);
  }
  return info;
}

/** One ordered batch, deduplicated for this call only. Transport errors propagate. */
export async function readAccounts(source: RouterDataSource, addresses: readonly Address[]) {
  const keys = [...new Set(addresses)];
  const results = await readAccountBatch(source, keys);
  return new Map(keys.map((key, index) => [key, validateAccount(results[index], key)]));
}

export function accountData(
  accounts: AccountMap,
  address: Address,
  owner: Address,
): Uint8Array {
  const info = accounts.get(address);
  if (!info) throw new RouterSdkError("MISSING_ACCOUNT", `Missing account ${address}.`);
  if (base58.encode(info.owner) !== owner || info.is_executable) {
    throw new RouterSdkError("INVALID_ACCOUNT", `Unexpected owner or executable state for ${address}.`);
  }
  return info.data;
}
