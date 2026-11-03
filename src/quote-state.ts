import { loadClamm, prepareClammQuote } from "./clamm.js";
import type { NetworkConfig } from "./config/networks.js";
import type { CoreRouteStep, Route } from "./config/routes.js";
import type { RouterDataSource } from "./types.js";
import { createAccountLoader, decodeAddress, deriveAddress, readAccounts } from "./utils.js";
import { prepareVaultQuote } from "./vault.js";

type VaultStep = Exclude<CoreRouteStep, { readonly venue: "clamm" }>;
type ClammStep = Extract<CoreRouteStep, { readonly venue: "clamm" }>;

/** Batch known addresses, then load CLAMM ticks inside its candidate: at most two reads. */
export async function prepareQuoteState(source: RouterDataSource, config: NetworkConfig, candidates: readonly Route[]) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const { programs, venues } = config;
  let initialBatchAvailable = false;
  const load = createAccountLoader({ async getAccounts(keys) {
    const results = await source.getAccounts(keys);
    // Account contents are validated separately; invalid framing loses the whole batch.
    initialBatchAvailable = Array.isArray(results) && results.length === keys.length;
    return results;
  } });
  const steps = [...new Map(candidates.flatMap((route) => route.steps).map((step) => [step.id, step])).values()];
  const hasRfq = steps.some((step) => step.venue === "propamm");
  const hasClamm = steps.some((step) => step.venue === "clamm");
  const pool = venues.clamm;
  const poolKeys = [pool.address, pool.tokenMintA, pool.tokenMintB];
  const vaultKeys = steps.flatMap((step) => {
    if (step.venue === "propamm" || step.venue === "clamm") return [];
    const venue = venues[step.venue];
    return [venue.address, venue.assetMint, venue.shareMint,
      deriveAddress(programs.vaultProgramId, "reserve", decodeAddress(venue.shareMint))];
  });
  const keys = [...vaultKeys, ...(hasClamm ? poolKeys : [])];
  // Prime the cache in one batch. Each candidate consumes only its own accounts.
  // Attach a handler even when the RFQ needs no accounts and can start immediately.
  const initial = load(keys);
  void initial.catch(() => {});
  const accounts = hasRfq ? await load(vaultKeys).catch(async (error: unknown) => {
    if (initialBatchAvailable || !hasClamm) throw error; // No optional CLAMM batch to recover from.
    // A failed combined batch leaves no shared state. Spend the second read only
    // on vaults for RFQ; CLAMM keeps its cached batch failure and cannot read ticks.
    return readAccounts(source, vaultKeys);
  }) : await initial;
  const vaults = new Map<string, ReturnType<typeof prepareVaultQuote>>();
  for (const step of steps) {
    if (step.venue !== "clamm" && step.venue !== "propamm") {
      vaults.set(step.id, prepareVaultQuote(accounts, venues[step.venue], step.operation, now, programs));
    }
  }
  const clamm = new Map<string, Promise<ReturnType<typeof prepareClammQuote>>>();
  return {
    vault(step: VaultStep) { return vaults.get(step.id)!; },
    clamm(step: ClammStep) {
      let quote = clamm.get(step.id);
      if (!quote) {
        quote = (async () => {
          const state = loadClamm(await load(poolKeys), step.inputMint === pool.tokenMintA, config);
          return prepareClammQuote(state, await load(state.addresses));
        })();
        clamm.set(step.id, quote);
      }
      return quote;
    },
  };
}
