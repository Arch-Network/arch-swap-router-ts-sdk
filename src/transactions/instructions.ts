import type { AccountMeta, Instruction } from "@arch-network/arch-sdk";
import { decodeAddress } from "../accounts/address.js";
import { deriveAssociatedTokenAddress } from "../accounts/pda.js";
import { encodeRouteExactInV1 } from "../codecs/instruction.js";
import { TESTNET } from "../config/testnet.js";
import { RouterSdkError } from "../errors/index.js";
import type { Address } from "../types.js";
import type { BuildSwapInput, ResolvedStep } from "./types.js";

function account(pubkey: Address, is_writable = false, is_signer = false): AccountMeta {
  return { pubkey: decodeAddress(pubkey), is_writable, is_signer };
}

function venueAccounts(step: ResolvedStep): AccountMeta[] {
  if (step.kind === "clamm") {
    return [
      account(TESTNET.clammProgramId),
      ...[step.pool, step.tokenVaultA, step.tokenVaultB, ...step.tickArrays,
        step.oracle, ...step.supplementalTickArrays].map((key) => account(key, true)),
    ];
  }
  const accounts = [
    account(TESTNET.vaultProgramId),
    account(step.vault, true),
    account(step.reserve, true),
  ];
  if (step.kind === "vaultRedeem") {
    accounts.push(account(step.escrow, true), account(step.redemptionEntry, true));
  }
  accounts.push(
    account(step.protocolFeeShares, true),
    account(step.managerFeeShares, true),
    account(step.eventAuthority),
  );
  if (step.kind === "vaultRedeem") accounts.push(account(TESTNET.systemProgramId));
  return accounts;
}

/** Build the router instruction from resolved state; no reads or transaction policy. */
export function buildRouterInstruction(input: BuildSwapInput): Instruction {
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 0) {
    throw new RouterSdkError("INVALID_INSTRUCTION", "deadlineMs must be a nonnegative safe integer.");
  }
  const data = encodeRouteExactInV1({
    amountIn: input.amountIn,
    minAmountOut: input.minAmountOut,
    deadlineMs: BigInt(input.deadlineMs),
    steps: input.steps.map((step) => step.kind === "clamm" ? {
      kind: step.kind,
      aToB: step.aToB,
      sqrtPriceLimit: step.sqrtPriceLimit,
      supplementalTickArrayCount: step.supplementalTickArrays.length,
    } : { kind: step.kind }),
  });
  const mints = [input.inputMint, ...input.steps.map((step) => step.outputMint)];
  const writableMints = new Set<Address>();
  for (const [index, step] of input.steps.entries()) {
    if (step.kind === "vaultMint") writableMints.add(step.outputMint);
    if (step.kind === "vaultRedeem") writableMints.add(mints[index]!);
  }
  const accounts = [account(input.user, true, true), account(TESTNET.tokenProgramId)];
  for (const mint of mints) {
    accounts.push(
      account(mint, writableMints.has(mint)),
      account(deriveAssociatedTokenAddress(input.user, mint), true),
    );
  }
  for (const step of input.steps) accounts.push(...venueAccounts(step));
  // This trailer enables router-owned creation of every missing user ATA.
  accounts.push(account(TESTNET.associatedTokenProgramId), account(TESTNET.systemProgramId));
  return { program_id: decodeAddress(TESTNET.routerProgramId), accounts, data };
}
