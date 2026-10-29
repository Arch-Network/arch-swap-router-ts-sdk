import {
  base58ToBytes, bytesToBase58, bytesToHex, decodeAplMint, decodeAplTokenAccount, PubkeyUtil, SanitizedMessageUtil,
  type AccountInfoResult, type AccountMeta, type Instruction, type Pubkey,
} from "@arch-network/arch-sdk";
import type { ProgramIds } from "./config/networks.js";
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

export function mulDiv(a: bigint, b: bigint, divisor: bigint): bigint {
  const product = a * b;
  if (product > U128_MAX) throw new RouterSdkError("MATH_OVERFLOW", "Vault product exceeds u128.");
  return u64(product / divisor);
}

export const applyFee = (fee: Fee, amount: bigint): bigint =>
  fee.kind === "fixed" ? fee.amount : u64((amount * BigInt(fee.bps) + 9999n) / 10_000n);

/** Smallest input reaching a target on one loaded route; at most 64 search probes. */
export function inputForOutput(estimate: (amountIn: bigint) => bigint, target: bigint) {
  let low = 1n, high = U64_MAX;
  while (low < high) {
    const mid = (low + high) / 2n;
    try {
      if (estimate(mid) < target) low = mid + 1n;
      else high = mid;
    } catch (error) {
      if (!(error instanceof RouterSdkError)) throw error;
      // Dust/fees form the lower boundary; capacity and integer limits form the upper.
      if (error.code === "ZERO_OUTPUT") low = mid + 1n;
      else if (["MATH_OVERFLOW", "DEPOSIT_CAP", "REDEEM_UNAVAILABLE", "INSUFFICIENT_LIQUIDITY"].includes(error.code)) high = mid;
      else throw error;
    }
  }
  // A capacity failure is not a successful estimate. Re-evaluate and propagate it.
  const amountOut = estimate(low);
  if (amountOut < target) {
    throw new RouterSdkError("OUTPUT_UNAVAILABLE", "The route cannot reach the requested output within u64 input.");
  }
  return { amountIn: low, amountOut };
}

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
  if (typeof address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]*$/.test(address)) {
    throw new RouterSdkError("INVALID_ADDRESS", "Address must be a base58-encoded public key.");
  }
  // Valid base58 from here: base58ToBytes fails only above 32 bytes and left-pads shorter values,
  // so only the canonical 32-byte spelling round-trips.
  let bytes: Uint8Array | undefined;
  try {
    bytes = base58ToBytes(address);
  } catch {
    bytes = undefined;
  }
  if (bytes === undefined || bytesToBase58(bytes) !== address) {
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

/** Compile with Rust's key ordering, required by the RFQ signing server. No reads. */
export function compileRouterMessage(instructions: readonly Instruction[], user: Address, recentBlockhash: Uint8Array) {
  const message = SanitizedMessageUtil.createSanitizedMessage([...instructions], decodeAddress(user), recentBlockhash);
  if (typeof message === "string") throw new RouterSdkError("INVALID_TRANSACTION", message);
  const { num_required_signatures: signers, num_readonly_signed_accounts: readonlySigners,
    num_readonly_unsigned_accounts: readonlyOthers } = message.header;
  const group = (i: number) => i === 0 ? 0 : i < signers - readonlySigners ? 1 : i < signers ? 2
    : i < message.account_keys.length - readonlyOthers ? 3 : 4;
  // arch-sdk uses insertion order; Rust uses a BTreeMap within each group.
  const keys = message.account_keys.map((key, i) => ({ key, i, hex: bytesToHex(key) }))
    .sort((a, b) => group(a.i) - group(b.i) || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
  const indices: number[] = [];
  keys.forEach(({ i }, index) => { indices[i] = index; });
  return {
    ...message,
    account_keys: keys.map(({ key }) => key),
    instructions: message.instructions.map((ix) => ({
      ...ix, program_id_index: indices[ix.program_id_index]!, accounts: ix.accounts.map((i) => indices[i]!),
    })),
  };
}

export function deriveProgramAddress(
  seeds: readonly Uint8Array[],
  programId: Address,
): readonly [Address, number] {
  const [address, bump] = PubkeyUtil.findProgramAddress(seeds, decodeAddress(programId));
  return [bytesToBase58(address), bump];
}

export function deriveAddress(programId: Address, seed: string, ...seeds: Uint8Array[]): Address {
  return deriveProgramAddress([new TextEncoder().encode(seed), ...seeds], programId)[0];
}

export function deriveAssociatedTokenAddress(owner: Address, mint: Address, programs: ProgramIds): Address {
  return bytesToBase58(
    PubkeyUtil.getAssociatedTokenAddress(
      decodeAddress(mint),
      decodeAddress(owner),
      true, // Arch's 32-byte x-only keys do not pass the SDK's SEC1 curve guard.
      decodeAddress(programs.tokenProgramId),
      decodeAddress(programs.associatedTokenProgramId),
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
  if (bytesToBase58(info.owner) !== owner || info.is_executable) {
    throw new RouterSdkError("INVALID_ACCOUNT", `Unexpected owner or executable state for ${address}.`);
  }
  return info.data;
}

/**
 * arch-sdk's APL decoders accept trailing bytes and any option tag; the router also requires the exact
 * length and valid `COption` tags (provenance in tests/fixtures/vault/README.md).
 */
function checkTokenData(data: Uint8Array, length: number, optionOffsets: readonly number[]): void {
  if (data.length !== length) throw new RouterSdkError("INVALID_ACCOUNT", `Expected ${length} APL bytes.`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (optionOffsets.some((offset) => view.getUint32(offset, true) > 1)) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Invalid APL option tag.");
  }
}

export function decodeMint(data: Uint8Array) {
  checkTokenData(data, 82, [0, 46]);
  if (data[45] !== 1) throw new RouterSdkError("INVALID_ACCOUNT", "Expected an initialized APL mint.");
  const { supply, decimals } = decodeAplMint(data);
  return { supply, decimals };
}

export function decodeTokenAccount(data: Uint8Array) {
  checkTokenData(data, 165, [72, 109, 129]);
  const { mint, owner, amount, state } = decodeAplTokenAccount(data);
  if (state !== 1 && state !== 2) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Expected an initialized APL token account.");
  }
  return { mint: bytesToBase58(mint), owner: bytesToBase58(owner), amount };
}
