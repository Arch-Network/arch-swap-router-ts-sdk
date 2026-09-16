import { base58 } from "@scure/base";
import type { AccountMeta, Instruction } from "@arch-network/arch-sdk";
import type { StepArgs } from "../../src/codecs/types.js";
import { TESTNET } from "../../src/config/testnet.js";
import type { QuoteRoutesRequest, RouteStep } from "../../src/types.js";
import type { ResolvedRouteQuote } from "../../src/venues/types.js";
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

function stepArgs(args: Fixture["hops"][number]["args"]): StepArgs {
  switch (args.kind) {
    case "vaultMint":
    case "vaultRedeem":
      return { kind: args.kind };
    case "clamm":
      if (args.aToB === undefined || args.sqrtPriceLimit === undefined || args.supplementalTickArrayCount === undefined) {
        throw new Error("Incomplete CLAMM fixture.");
      }
      return {
        kind: "clamm", aToB: args.aToB, sqrtPriceLimit: BigInt(args.sqrtPriceLimit),
        supplementalTickArrayCount: args.supplementalTickArrayCount,
      };
    default:
      throw new Error(`Unknown fixture step: ${args.kind}`);
  }
}

/** Synthetic quote metadata; the expected instructions and account keys come from Rust. */
export function buildInputs(fixture: Fixture): { resolved: ResolvedRouteQuote; request: QuoteRoutesRequest } {
  const amountIn = BigInt(fixture.amountIn);
  const inputMint = fixture.mints[0]!;
  const outputMint = fixture.mints[fixture.mints.length - 1]!;
  const hops = fixture.hops.map((hop, index) => {
    const args = stepArgs(hop.args);
    const step: RouteStep = {
      venueId: `fixture-venue-${index}`, operation: args.kind,
      inputMint: fixture.mints[index]!, outputMint: fixture.mints[index + 1]!,
    };
    return {
      quote: { step, amountIn: index === 0 ? amountIn : 100n, estimatedAmountOut: 100n, fees: [] },
      args, accounts: hop.accounts.map(account),
    };
  });
  return {
    resolved: {
      quote: {
        deployment: TESTNET,
        route: { id: fixture.name, inputMint, outputMint, steps: hops.map((hop) => hop.quote.step) },
        amountIn, estimatedAmountOut: 100n, minAmountOut: BigInt(fixture.minAmountOut),
        hops: hops.map((hop) => hop.quote), fees: [],
      },
      hops,
    },
    request: { inputMint, outputMint, amountIn, slippageBps: 9_900, user: fixture.user, deadlineMs: fixture.deadlineMs },
  };
}

export function expectedInstructions(fixture: Fixture): Instruction[] {
  return fixture.instructions.map((ix) => ({
    program_id: base58.decode(ix.programId), accounts: ix.accounts.map(account), data: Uint8Array.from(ix.data),
  }));
}
