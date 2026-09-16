import { base58 } from "@scure/base";
import type { AccountMeta, Instruction } from "@arch-network/arch-sdk";
import type { BuildSwapInput, ResolvedStep } from "../../src/transactions/types.js";
import data from "../fixtures/transactions/v1.json" with { type: "json" };

export const fixtures = data.cases;
type Fixture = (typeof fixtures)[number];

export function namedFixture(name: string): Fixture {
  const fixture = fixtures.find((item) => item.name === name);
  if (!fixture) throw new Error(`Missing transaction fixture: ${name}`);
  return fixture;
}

function account(meta: Fixture["instructions"][number]["accounts"][number]): AccountMeta {
  return { ...meta, pubkey: base58.decode(meta.pubkey) };
}

/** Resolve named inputs from Rust fixtures without synthetic quote/fee metadata. */
export function buildInput(fixture: Fixture): BuildSwapInput {
  const steps = fixture.hops.map((hop, index): ResolvedStep => {
    const key = (position: number) => hop.accounts[position]!.pubkey;
    const outputMint = fixture.mints[index + 1]!;
    switch (hop.args.kind) {
      case "vaultMint":
        return {
          kind: "vaultMint", outputMint, vault: key(1), reserve: key(2),
          protocolFeeShares: key(3), managerFeeShares: key(4), eventAuthority: key(5),
        };
      case "vaultRedeem":
        return {
          kind: "vaultRedeem", outputMint, vault: key(1), reserve: key(2),
          escrow: key(3), redemptionEntry: key(4),
          protocolFeeShares: key(5), managerFeeShares: key(6), eventAuthority: key(7),
        };
      case "clamm":
        if (hop.args.aToB === undefined || hop.args.sqrtPriceLimit === undefined) {
          throw new Error("Incomplete CLAMM fixture.");
        }
        return {
          kind: "clamm", outputMint, pool: key(1), tokenVaultA: key(2), tokenVaultB: key(3),
          tickArrays: [key(4), key(5), key(6)], oracle: key(7),
          aToB: hop.args.aToB, sqrtPriceLimit: BigInt(hop.args.sqrtPriceLimit),
          supplementalTickArrays: hop.accounts.slice(8).map((meta) => meta.pubkey),
        };
      default:
        throw new Error(`Unknown fixture step: ${hop.args.kind}`);
    }
  });
  return {
    inputMint: fixture.mints[0]!,
    user: fixture.user,
    amountIn: BigInt(fixture.amountIn),
    minAmountOut: BigInt(fixture.minAmountOut),
    deadlineMs: fixture.deadlineMs,
    steps,
  };
}

/** Original fixture includes input ATA setup first; compare only its router instruction. */
export function expectedRouterInstruction(fixture: Fixture): Instruction {
  const ix = fixture.instructions[1]!;
  return {
    program_id: base58.decode(ix.programId),
    accounts: ix.accounts.map(account),
    data: Uint8Array.from(ix.data),
  };
}
