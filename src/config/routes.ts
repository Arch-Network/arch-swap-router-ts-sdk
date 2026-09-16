import type { StepArgs } from "../codecs/types.js";
import type { Address } from "../types.js";
import { TESTNET_MINTS as mints, TESTNET_VENUES } from "./testnet.js";

interface RouteStep {
  readonly venue: keyof typeof TESTNET_VENUES;
  readonly operation: StepArgs["kind"];
  readonly inputMint: Address;
  readonly outputMint: Address;
}

const mintBtc = Object.freeze({ venue: "btcVault", operation: "vaultMint", inputMint: mints.aBTC, outputMint: mints.primeBTC } as const);
const redeemBtc = Object.freeze({ venue: "btcVault", operation: "vaultRedeem", inputMint: mints.primeBTC, outputMint: mints.aBTC } as const);
const mintUsd = Object.freeze({ venue: "usdVault", operation: "vaultMint", inputMint: mints.aUSD, outputMint: mints.primeUSD } as const);
const redeemUsd = Object.freeze({ venue: "usdVault", operation: "vaultRedeem", inputMint: mints.primeUSD, outputMint: mints.aUSD } as const);
const btcToUsd = Object.freeze({ venue: "clamm", operation: "clamm", inputMint: mints.aBTC, outputMint: mints.aUSD } as const);
const usdToBtc = Object.freeze({ venue: "clamm", operation: "clamm", inputMint: mints.aUSD, outputMint: mints.aBTC } as const);

/** Explicit paths, never inferred by traversing venue connections. */
export const FIXED_ROUTES = Object.freeze(([
  [mintBtc],
  [redeemBtc],
  [mintUsd],
  [redeemUsd],
  [btcToUsd],
  [usdToBtc],
  [redeemBtc, btcToUsd],
  [usdToBtc, mintBtc],
  [redeemUsd, usdToBtc],
  [btcToUsd, mintUsd],
  [redeemBtc, btcToUsd, mintUsd],
  [redeemUsd, usdToBtc, mintBtc],
] satisfies RouteStep[][]).map((steps) => Object.freeze({
  inputMint: steps[0]!.inputMint,
  outputMint: steps[steps.length - 1]!.outputMint,
  steps: Object.freeze(steps),
})));

export const SUPPORTED_PAIRS = Object.freeze(
  FIXED_ROUTES.map(({ inputMint, outputMint }) => Object.freeze({ inputMint, outputMint })),
);
