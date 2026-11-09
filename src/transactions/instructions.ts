import type { AccountMeta, Instruction } from "@arch-network/arch-sdk";
import { encodeRouteExactInV1 } from "../codecs/instruction.js";
import type { ProgramIds } from "../config/networks.js";
import { RouterSdkError } from "../errors.js";
import type { Address } from "../types.js";
import { account, compileRouterMessage, decodeAddress, deriveAssociatedTokenAddress } from "../utils.js";
import type { BuildSwapInput, ResolvedStep } from "./types.js";
import { assertMessageLimits } from "./size.js";

function venueAccounts(step: ResolvedStep, programs: ProgramIds): AccountMeta[] {
  if (step.kind === "treasuryMint") {
    return [
      account(step.bridgeProgramId), account(step.treasuryAuthority, true, true),
      account(step.bridgeConfig), account(step.assetConfig), account(step.issuanceReceipt, true),
      account(step.mintAuthority), account(step.propammConfig), account(step.paymentVault, true),
      account(programs.associatedTokenProgramId), account(programs.systemProgramId),
    ];
  }
  if (step.kind === "propamm") {
    return [
      account(step.programId), account(step.config), account(step.maker, false, true),
      account(step.userNonce, true), account(step.baseVault, true), account(step.quoteVault, true),
      account(programs.systemProgramId),
    ];
  }
  if (step.kind === "clamm") {
    return [
      account(programs.clammProgramId),
      ...[step.pool, step.tokenVaultA, step.tokenVaultB, ...step.tickArrays,
        step.oracle, ...step.supplementalTickArrays].map((key) => account(key, true)),
    ];
  }
  const accounts = [
    account(programs.vaultProgramId),
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
  if (step.kind === "vaultRedeem") accounts.push(account(programs.systemProgramId));
  return accounts;
}

/** Build the router instruction from resolved state; no reads or transaction policy. */
export function buildRouterInstruction(input: BuildSwapInput, programs: ProgramIds): Instruction {
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
    } : step.kind === "propamm" || step.kind === "treasuryMint" ? step : { kind: step.kind }),
  });
  const mints = [input.inputMint, ...input.steps.map((step) => step.outputMint)];
  const writableMints = new Set<Address>();
  for (const [index, step] of input.steps.entries()) {
    if (step.kind === "vaultMint" || step.kind === "treasuryMint") writableMints.add(step.outputMint);
    if (step.kind === "vaultRedeem") writableMints.add(mints[index]!);
  }
  const accounts = [account(input.user, true, true), account(programs.tokenProgramId)];
  for (const mint of mints) {
    accounts.push(
      account(mint, writableMints.has(mint)),
      account(deriveAssociatedTokenAddress(input.user, mint, programs), true),
    );
  }
  for (const step of input.steps) accounts.push(...venueAccounts(step, programs));
  // This trailer enables router-owned creation of every missing user ATA.
  accounts.push(account(programs.associatedTokenProgramId), account(programs.systemProgramId));
  return { program_id: decodeAddress(programs.routerProgramId), accounts, data };
}

/** Server-quoted layout: input ATA + router, measured with both required signatures. */
export function buildPropAmmInstructions(input: BuildSwapInput, programs: ProgramIds): Instruction[] {
  const router = buildRouterInstruction(input, programs);
  const step = input.steps.find((step) => step.kind === "propamm" || step.kind === "treasuryMint");
  if (!step) throw new RouterSdkError("INVALID_RFQ", "Missing server-quoted step.");
  const treasury = step.kind === "treasuryMint";
  const maker = decodeAddress(treasury ? step.treasuryAuthority : step.maker);
  if (router.accounts.filter((meta) => meta.pubkey.every((b, i) => b === maker[i])).length !== 1) {
    throw new RouterSdkError("INVALID_RFQ", "Server signer must appear only in its venue account group.");
  }
  const instructions = [{
    program_id: decodeAddress(programs.associatedTokenProgramId),
    accounts: [
      account(input.user, true, true),
      account(deriveAssociatedTokenAddress(input.user, input.inputMint, programs), true),
      account(input.user), account(input.inputMint),
      account(programs.systemProgramId), account(programs.tokenProgramId),
    ],
    data: Uint8Array.of(1),
  }, router];
  // Placeholders are for measurement only; callers compile with a fresh blockhash.
  const message = compileRouterMessage(instructions, input.user, new Uint8Array(32));
  if (message.header.num_required_signatures !== 2
    || message.header.num_readonly_signed_accounts !== (treasury ? 0 : 1)) {
    throw new RouterSdkError("INVALID_RFQ", "RFQ user and server signer privileges are invalid.");
  }
  assertMessageLimits(message, treasury ? "Treasury mint transaction" : "PropAMM transaction");
  return instructions;
}
