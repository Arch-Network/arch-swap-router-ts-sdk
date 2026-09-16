
import type { AccountMeta, Instruction } from "@arch-network/arch-sdk";
import { decodeAddress } from "../accounts/address.js";
import { deriveAssociatedTokenAddress } from "../accounts/pda.js";
import { encodeRouteExactInV1 } from "../codecs/instruction.js";
import { RouterSdkError } from "../errors/index.js";
import type { Address, QuoteRoutesRequest, RouterDeployment, RouteStep } from "../types.js";
import type { ResolvedHopQuote, ResolvedRouteQuote } from "../venues/types.js";

function account(pubkey: Address, is_writable = false, is_signer = false): AccountMeta {
  return { pubkey: decodeAddress(pubkey), is_writable, is_signer };
}

function sameStep(left: RouteStep, right: RouteStep): boolean {
  return left.venueId === right.venueId && left.operation === right.operation &&
    left.inputMint === right.inputMint && left.outputMint === right.outputMint;
}

function venueAccounts(hop: ResolvedHopQuote, deployment: RouterDeployment): AccountMeta[] {
  const kind = hop.args.kind;
  const writable = kind === "vaultMint"
    ? [false, true, true, true, true, false]
    : kind === "vaultRedeem"
      ? [false, true, true, true, true, true, true, false, false]
      : [false, true, true, true, true, true, true, true,
        ...Array<boolean>(hop.args.supplementalTickArrayCount).fill(true)];
  if (hop.accounts.length !== writable.length) {
    throw new RouterSdkError("INVALID_ACCOUNTS", `${kind} requires ${writable.length} venue accounts.`);
  }
  const program = decodeAddress(kind === "clamm" ? deployment.clammProgramId : deployment.vaultProgramId);
  const system = decodeAddress(deployment.systemProgramId);
  return hop.accounts.map((meta, index) => {
    if (meta.pubkey.length !== 32 || meta.is_signer !== false || meta.is_writable !== writable[index]) {
      throw new RouterSdkError("INVALID_ACCOUNTS", `Invalid ${kind} venue account at position ${index}.`);
    }
    const expectedProgram = index === 0 ? program : kind === "vaultRedeem" && index === 8 ? system : undefined;
    if (expectedProgram && !meta.pubkey.every((byte, i) => byte === expectedProgram[i])) {
      throw new RouterSdkError("INVALID_ACCOUNTS", `Wrong ${kind} program at position ${index}.`);
    }
    // Preserve every position, including coincident fee destinations and ticks.
    return { ...meta, pubkey: meta.pubkey.slice() };
  });
}

/** Assemble only from resolved quote data; this function performs no account reads. */
export function buildInstructionBundle(
  resolved: ResolvedRouteQuote,
  request: QuoteRoutesRequest,
  deployment: RouterDeployment,
): readonly Instruction[] {
  const { quote, hops } = resolved;
  const route = quote.route;
  if (
    quote.amountIn !== request.amountIn || route.inputMint !== request.inputMint ||
    route.outputMint !== request.outputMint || route.steps.length !== hops.length ||
    (Object.keys(deployment) as (keyof RouterDeployment)[]).some(
      (key) => deployment[key] !== quote.deployment[key],
    )
  ) {
    throw new RouterSdkError("QUOTE_MISMATCH", "Resolved quote does not match the request and deployment.");
  }
  if (!Number.isSafeInteger(request.deadlineMs) || request.deadlineMs < 0) {
    throw new RouterSdkError("INVALID_INSTRUCTION", "deadlineMs must be a nonnegative safe integer.");
  }
  // Validate wire arguments before using CLAMM supplement counts in assembly.
  const data = encodeRouteExactInV1({
    amountIn: quote.amountIn,
    minAmountOut: quote.minAmountOut,
    deadlineMs: BigInt(request.deadlineMs),
    steps: hops.map((hop) => hop.args),
  });
  const mints: Address[] = [route.inputMint];
  const writableMints = new Set<Address>();
  for (const [index, step] of route.steps.entries()) {
    const hop = hops[index]!; // Counts were checked above.
    if (!sameStep(step, hop.quote.step) || step.operation !== hop.args.kind) {
      throw new RouterSdkError("QUOTE_MISMATCH", `Resolved hop ${index} does not match the route step.`);
    }
    if (step.inputMint !== mints[index] || mints.includes(step.outputMint)) {
      throw new RouterSdkError("INVALID_ROUTE", "Route steps must form a continuous path with unique mints.");
    }
    mints.push(step.outputMint);
    if (step.operation === "vaultMint") writableMints.add(step.outputMint);
    if (step.operation === "vaultRedeem") writableMints.add(step.inputMint);
  }
  if (mints[mints.length - 1] !== route.outputMint) {
    throw new RouterSdkError("INVALID_ROUTE", "The last hop must end at the route output mint.");
  }
  const atas = mints.map((mint) => deriveAssociatedTokenAddress(request.user, mint, deployment));
  const accounts = [account(request.user, true, true), account(deployment.tokenProgramId)];
  for (const [index, mint] of mints.entries()) {
    accounts.push(account(mint, writableMints.has(mint)), account(atas[index]!, true));
  }
  for (const hop of hops) accounts.push(...venueAccounts(hop, deployment));
  accounts.push(account(deployment.associatedTokenProgramId), account(deployment.systemProgramId));

  // Match Rust with_ata_creation: one idempotent input ATA instruction, then
  // the router. Missing intermediate/output ATAs are prepared inside the router.
  const createInputAta: Instruction = {
    program_id: decodeAddress(deployment.associatedTokenProgramId),
    accounts: [
      account(request.user, true, true),
      account(atas[0]!, true),
      account(request.user),
      account(route.inputMint),
      account(deployment.systemProgramId),
      account(deployment.tokenProgramId),
    ],
    data: Uint8Array.of(1),
  };
  return [createInputAta, { program_id: decodeAddress(deployment.routerProgramId), accounts, data }];
}
