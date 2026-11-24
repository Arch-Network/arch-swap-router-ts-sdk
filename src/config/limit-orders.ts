import type { Address } from "../accounts.js";
import type { Network } from "./shared.js";

/** PropAMM program and config holding limit orders; the same deployment as each network's PropAMM markets. */
export const LIMIT_ORDER_DEPLOYMENTS = Object.freeze({
  testnet: Object.freeze({
    programId: "9EqAsENtgBA4Uo4wbS8LVdaQJjMKPpagMxgDVhxEWtKq",
    config: "7X7QM1eEQwgE9b6tA4HMGxWGdzuTvcU9ip9FeZS338yn",
  }),
  mainnet: Object.freeze({
    programId: "5KMw4VNavLhM5wxTxyQGm8hs5ymFhqMCZ5BpkHybcEBV",
    config: "3jwSNH8P5tNFMY72ZwFi5z3gEkK1vVor3xcAFvr4DHzr",
  }),
} satisfies Record<Network, { readonly programId: Address; readonly config: Address }>);
