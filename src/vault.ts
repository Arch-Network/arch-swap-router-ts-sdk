// Minimal arch-vaults state/preview port, aligned with native Mint and Redeem.
// Source revisions, layout and math fixtures: tests/fixtures/vault/README.md.
import { base58 } from "@scure/base";
import { TESTNET } from "./config/testnet.js";
import { RouterSdkError } from "./errors.js";
import type { ResolvedStep } from "./transactions/types.js";
import type { Address } from "./types.js";
import {
  accountData, applyFee, decodeAddress, decodeMint, decodeTokenAccount,
  deriveAssociatedTokenAddress, deriveVaultAddress, mulDiv, u64, type AccountMap, type Fee,
} from "./utils.js";

type Operation = "vaultMint" | "vaultRedeem";
interface VaultVenue { readonly address: Address; readonly assetMint: Address; readonly shareMint: Address }

/** Fixed zero-copy offsets include the discriminator. Decode only fields used here. */
export function decodeVault(data: Uint8Array) {
  if (data.length !== 616 || ![211, 8, 232, 43, 2, 152, 117, 119].every((b, i) => data[i] === b)) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Invalid vault length or discriminator.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fee = (offset: number): Fee => {
    const value = view.getBigUint64(offset + 8, true);
    if (data[offset] === 0) return { kind: "fixed", amount: value };
    if (data[offset] === 1 && value <= 65535n) return { kind: "percentage", bps: Number(value) };
    throw new RouterSdkError("INVALID_ACCOUNT", "Invalid stored vault fee.");
  };
  const key = (offset: number) => base58.encode(data.subarray(offset, offset + 32));
  return {
    offChainBalance: view.getBigUint64(8, true),
    offChainReportedAt: view.getBigInt64(16, true),
    maxTotalAssets: view.getBigUint64(24, true),
    queueHead: view.getBigUint64(40, true),
    queueTail: view.getBigUint64(48, true),
    mintFee: fee(56), redeemFee: fee(72),
    maxNavStalenessSecs: view.getUint32(88, true),
    feeRecipient: key(201), protocolFeeRecipient: key(233),
    assetMint: key(265), shareMint: key(297), reserve: key(329), escrow: key(361),
    paused: data[393] !== 0,
  };
}

// Native virtual offsets: 1 asset, 1000 shares. Raw units; no decimal rescaling.
export const sharesForAssets = (assets: bigint, total: bigint, supply: bigint): bigint =>
  mulDiv(assets, supply + 1000n, total + 1n);
export const assetsForShares = (shares: bigint, total: bigint, supply: bigint): bigint =>
  mulDiv(shares, total + 1n, supply + 1000n);
/** Estimate only a full immediate swap, using the same pre-flow supply as native code. */
export function estimateVault(
  vault: ReturnType<typeof decodeVault>, reserve: bigint, supply: bigint,
  operation: Operation, amountIn: bigint, now: bigint,
): bigint {
  if (vault.paused) throw new RouterSdkError("VAULT_PAUSED", "Vault is paused.");
  if (operation === "vaultMint") {
    const age = now - vault.offChainReportedAt;
    if (age < -(1n << 63n) || age > (1n << 63n) - 1n) {
      throw new RouterSdkError("MATH_OVERFLOW", "NAV age exceeds i64.");
    }
    if (age > BigInt(vault.maxNavStalenessSecs)) {
      throw new RouterSdkError("STALE_NAV", "Vault NAV is too old for Mint.");
    }
  } else if (vault.queueHead !== vault.queueTail) {
    throw new RouterSdkError("REDEEM_UNAVAILABLE", "Immediate redemption requires an empty queue.");
  }
  const total = u64(reserve + vault.offChainBalance);
  let amountOut: bigint;
  if (operation === "vaultMint") {
    const fee = applyFee(vault.mintFee, amountIn);
    if (fee >= amountIn) throw new RouterSdkError("ZERO_OUTPUT", "Mint fee consumes the deposit.");
    amountOut = sharesForAssets(amountIn - fee, total, supply);
    // The whole deposit enters the reserve, including the fee.
    if (total + amountIn > vault.maxTotalAssets) {
      throw new RouterSdkError("DEPOSIT_CAP", "Deposit exceeds the vault cap.");
    }
    u64(supply + amountOut + sharesForAssets(fee, total, supply));
  } else {
    if (vault.redeemFee.kind !== "percentage") {
      throw new RouterSdkError("INVALID_ACCOUNT", "Redeem requires a percentage fee.");
    }
    const gross = assetsForShares(amountIn, total, supply);
    const fee = applyFee(vault.redeemFee, gross);
    if (fee >= gross) throw new RouterSdkError("ZERO_OUTPUT", "Redemption has no net output.");
    if (gross > reserve) {
      throw new RouterSdkError("REDEEM_UNAVAILABLE", "Reserve cannot cover the full gross redemption.");
    }
    u64(vault.queueTail + 1n);
    u64(u64(supply - amountIn) + sharesForAssets(fee, total, supply));
    amountOut = gross - fee;
  }
  if (amountOut === 0n) throw new RouterSdkError("ZERO_OUTPUT", "Vault output rounds to zero.");
  return amountOut;
}

export function quoteVault(
  accounts: AccountMap, venue: VaultVenue, operation: Operation, amountIn: bigint, now: bigint,
): { amountOut: bigint; resolved: ResolvedStep } {
  const shareKey = decodeAddress(venue.shareMint);
  const reserveAddress = deriveVaultAddress("reserve", shareKey);
  const vault = decodeVault(accountData(accounts, venue.address, TESTNET.vaultProgramId));
  const reserve = decodeTokenAccount(accountData(accounts, reserveAddress, TESTNET.tokenProgramId));
  decodeMint(accountData(accounts, venue.assetMint, TESTNET.tokenProgramId));
  const shares = decodeMint(accountData(accounts, venue.shareMint, TESTNET.tokenProgramId));
  const escrow = deriveVaultAddress("escrow", shareKey);
  if (vault.assetMint !== venue.assetMint || vault.shareMint !== venue.shareMint
    || vault.reserve !== reserveAddress || vault.escrow !== escrow
    || reserve.mint !== venue.assetMint || reserve.owner !== venue.address) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Vault or reserve does not match the selected pair.");
  }
  // Management fees accrue only in Report, never speculatively during Mint/Redeem.
  const amountOut = estimateVault(vault, reserve.amount, shares.supply, operation, amountIn, now);
  const common = {
    vault: venue.address, reserve: reserveAddress,
    protocolFeeShares: deriveAssociatedTokenAddress(vault.protocolFeeRecipient, venue.shareMint),
    managerFeeShares: deriveAssociatedTokenAddress(vault.feeRecipient, venue.shareMint),
    eventAuthority: deriveVaultAddress("__event_authority"),
  };
  if (operation === "vaultMint") {
    return { amountOut, resolved: { ...common, kind: operation, outputMint: venue.shareMint } };
  }
  const tail = new Uint8Array(8);
  new DataView(tail.buffer).setBigUint64(0, vault.queueTail, true);
  return {
    amountOut,
    resolved: {
      ...common, kind: operation, outputMint: venue.assetMint, escrow,
      redemptionEntry: deriveVaultAddress("redeem", decodeAddress(venue.address), tail),
    },
  };
}
