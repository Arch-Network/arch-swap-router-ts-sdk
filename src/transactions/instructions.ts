import { RUNTIME_TX_SIZE_LIMIT, TransactionUtil, type AccountMeta, type Instruction } from "@arch-network/arch-sdk";
import { encodeRouteExactInV1 } from "../codecs/instruction.js";
import type { ProgramIds } from "../config/networks.js";
import { RouterSdkError } from "../errors.js";
import type { Address } from "../types.js";
import { account, compileRouterMessage, decodeAddress, deriveAssociatedTokenAddress } from "../utils.js";
import type { BuildSwapInput, ResolvedStep } from "./types.js";

function venueAccounts(step: ResolvedStep, programs: ProgramIds): AccountMeta[] {
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
    } : step.kind === "propamm" ? { kind: step.kind, terms: step.terms } : { kind: step.kind }),
  });
  const mints = [input.inputMint, ...input.steps.map((step) => step.outputMint)];
  const writableMints = new Set<Address>();
  for (const [index, step] of input.steps.entries()) {
    if (step.kind === "vaultMint") writableMints.add(step.outputMint);
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

/** Native RFQ layout: input ATA + router, measured with both required signatures. */
export function buildPropAmmInstructions(input: BuildSwapInput, programs: ProgramIds): Instruction[] {
  const router = buildRouterInstruction(input, programs);
  const step = input.steps.find((step) => step.kind === "propamm");
  if (!step) throw new RouterSdkError("INVALID_RFQ", "Missing PropAMM step.");
  const maker = decodeAddress(step.maker);
  if (router.accounts.filter((meta) => meta.pubkey.every((b, i) => b === maker[i])).length !== 1) {
    throw new RouterSdkError("INVALID_RFQ", "Maker must appear only in the PropAMM account group.");
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
    || message.header.num_readonly_signed_accounts !== 1) {
    throw new RouterSdkError("INVALID_RFQ", "RFQ requires a writable user and a read-only maker signer.");
  }
  const size = TransactionUtil.serializedSize({ version: 0, message, signatures: [new Uint8Array(64), new Uint8Array(64)] });
  if (size > RUNTIME_TX_SIZE_LIMIT) {
    throw new RouterSdkError("TRANSACTION_TOO_LARGE", `PropAMM transaction is ${size} bytes; limit is ${RUNTIME_TX_SIZE_LIMIT}.`);
  }
  return instructions;
}
