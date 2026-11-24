import type { Address } from "../accounts.js";
import { MAINNET_MINTS } from "./mainnet-mints.js";

export { MAINNET_MINTS } from "./mainnet-mints.js";

export const TESTNET_MINTS = Object.freeze({
  aBTC: "2yHWVNYyjnsxZqpnvTbPzWiHwpNQ2zBQU6BC4Lnbu7sW",
  aUSD: "6mqUuwPYehXei6mGBY4bQ6XK1z7e6rrFAZRzYKdH8qkp",
  primeBTC: "5Ba27gr7DPWvR8oyNZ3q3Jn2cKK2KLEpSgcggzbTQ1fh",
  primeUSD: "FynmgKXHUgVUToj9LSixpcXq8YirSekcxQjnebkeJ427",
} as const);

/** Core tokens exist on both networks; additional mainnet tokens are absent on testnet. */
export type NetworkMints = Readonly<Record<keyof typeof TESTNET_MINTS, Address>
  & Partial<Record<Exclude<keyof typeof MAINNET_MINTS, keyof typeof TESTNET_MINTS>, Address>>>;
