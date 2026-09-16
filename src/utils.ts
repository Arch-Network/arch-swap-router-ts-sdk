import { PubkeyUtil, type AccountInfoResult, type AccountMeta, type Pubkey } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { TESTNET } from "./config/testnet.js";
import { RouterSdkError } from "./errors.js";
import type { Address, RouterDataSource } from "./types.js";

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const U256_MAX = (1n << 256n) - 1n;
export type AccountMap = ReadonlyMap<Address, AccountInfoResult | null>;

export type Fee = { kind: "fixed"; amount: bigint } | { kind: "percentage"; bps: number };

export function u64(value: bigint): bigint {
  if (value < 0n || value > U64_MAX) throw new RouterSdkError("MATH_OVERFLOW", "Amount exceeds u64.");
  return value;
}

export function u128(value: bigint): bigint {
  if (value < 0n || value > U128_MAX) throw new RouterSdkError("MATH_OVERFLOW", "Value exceeds u128.");
  return value;
}

export function u256(value: bigint): bigint {
  if (value < 0n || value > U256_MAX) throw new RouterSdkError("MATH_OVERFLOW", "Value exceeds u256.");
  return value;
}

export const divRoundUp = (value: bigint, divisor: bigint): bigint => (value + divisor - 1n) / divisor;

export function readU128(view: DataView, offset: number, signed = false): bigint {
  const high = signed ? view.getBigInt64(offset + 8, true) : view.getBigUint64(offset + 8, true);
  return (high << 64n) + view.getBigUint64(offset, true);
}

export function mulDiv(a: bigint, b: bigint, divisor: bigint): bigint {
  const product = a * b;
  if (product > U128_MAX) throw new RouterSdkError("MATH_OVERFLOW", "Vault product exceeds u128.");
  return u64(product / divisor);
}

export const applyFee = (fee: Fee, amount: bigint): bigint =>
  fee.kind === "fixed" ? fee.amount : u64((amount * BigInt(fee.bps) + 9999n) / 10_000n);

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

export function deriveVaultAddress(seed: string, ...seeds: Uint8Array[]): Address {
  return deriveProgramAddress([new TextEncoder().encode(seed), ...seeds], TESTNET.vaultProgramId)[0];
}

export function deriveClammAddress(seed: string, ...seeds: Uint8Array[]): Address {
  return deriveProgramAddress([new TextEncoder().encode(seed), ...seeds], TESTNET.clammProgramId)[0];
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

/** One ordered batch, deduplicated for this call only. Transport errors propagate. */
export async function readAccounts(source: RouterDataSource, addresses: readonly Address[]) {
  const keys = [...new Set(addresses)];
  const results = await source.getAccounts(keys);
  if (!Array.isArray(results) || results.length !== keys.length) {
    throw new RouterSdkError("INVALID_RESPONSE", "Account response must match the requested batch length.");
  }
  const accounts = new Map<Address, AccountInfoResult | null>();
  for (const [index, key] of keys.entries()) {
    const info = results[index];
    if (info !== null && (
      !info || !(info.data instanceof Uint8Array) || !(info.owner instanceof Uint8Array)
      || info.owner.length !== 32 || !Number.isInteger(info.lamports) || info.lamports < 0
      || typeof info.utxo !== "string" || typeof info.is_executable !== "boolean"
    )) {
      throw new RouterSdkError("INVALID_RESPONSE", `Malformed account response for ${key}.`);
    }
    accounts.set(key, info);
  }
  return accounts;
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

/** Minimal APL readers, adapted from arch-vaults; provenance in tests/fixtures/vault/README.md. */
function tokenData(data: Uint8Array, length: number, optionOffsets: readonly number[]): DataView {
  if (data.length !== length) throw new RouterSdkError("INVALID_ACCOUNT", `Expected ${length} APL bytes.`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (optionOffsets.some((offset) => view.getUint32(offset, true) > 1)) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Invalid APL option tag.");
  }
  return view;
}

export function decodeMint(data: Uint8Array) {
  const view = tokenData(data, 82, [0, 46]);
  if (data[45] !== 1) throw new RouterSdkError("INVALID_ACCOUNT", "Expected an initialized APL mint.");
  return { supply: view.getBigUint64(36, true), decimals: data[44]! };
}

export function decodeTokenAccount(data: Uint8Array) {
  const view = tokenData(data, 165, [72, 109, 129]);
  if (data[108] !== 1 && data[108] !== 2) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Expected an initialized APL token account.");
  }
  return {
    mint: base58.encode(data.subarray(0, 32)),
    owner: base58.encode(data.subarray(32, 64)),
    amount: view.getBigUint64(64, true),
  };
}
