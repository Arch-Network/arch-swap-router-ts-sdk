import { RouterSdkError } from "./errors.js";
import { loadClamm, prepareClammQuote } from "./clamm.js";
import type { NetworkConfig } from "./config/networks.js";
import type { CoreRouteStep, Route } from "./config/routes.js";
import type { RouterDataSource } from "./types.js";
import { createAccountLoader, decodeAddress, deriveAddress } from "./utils.js";
import { prepareVaultQuote } from "./vault.js";

type VaultStep = Exclude<CoreRouteStep, { readonly venue: "clamm" }>;
type ClammStep = Extract<CoreRouteStep, { readonly venue: "clamm" }>;

/** Batch known addresses, then load CLAMM ticks inside its candidate: at most two reads. */
export async function prepareQuoteState(source: RouterDataSource, config: NetworkConfig, candidates: readonly Route[]) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const { programs, venues } = config;
  let initialBatchAvailable = false;
  const boundedSource: RouterDataSource = { async getAccounts(keys) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let results;
    try {
      results = await Promise.race([source.getAccounts(keys), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RouterSdkError("NO_ROUTE", "Account read exceeded 2 seconds.")), 2000);
      })]);
    } finally { clearTimeout(timer); }
    // Account contents are validated separately; invalid framing loses the whole batch.
    initialBatchAvailable = Array.isArray(results) && results.length === keys.length;
    return results;
  } };
  const load = createAccountLoader(boundedSource);
  const steps = [...new Map(candidates.flatMap((route) => route.steps).map((step) => [step.id, step])).values()];
  const hasRfq = steps.some((step) => step.venue === "propamm");
  const hasClamm = steps.some((step) => step.venue === "clamm");
  const pool = venues.clamm;
  const poolKeys = [pool.address, pool.tokenMintA, pool.tokenMintB];
  const vaultSteps = steps.filter((step): step is VaultStep => step.venue !== "propamm" && step.venue !== "clamm");
  const keysForVault = (step: VaultStep) => {
    const venue = venues[step.venue];
    return [venue.address, venue.assetMint, venue.shareMint,
      deriveAddress(programs.vaultProgramId, "reserve", decodeAddress(venue.shareMint))];
  };
  const vaultKeys = vaultSteps.flatMap(keysForVault);
  const keys = [...vaultKeys, ...(hasClamm ? poolKeys : [])];
  // Prime the cache in one batch. Each candidate consumes only its own accounts.
  // Attach a handler even when the RFQ needs no accounts and can start immediately.
  const initial = load(keys);
  void initial.catch(() => {});
  let loadVault = load;
  try {
    await (hasRfq ? load(vaultKeys) : initial);
  } catch {
    // Keep individual failures in the cache; each vault consumes only its keys.
    if (hasRfq && hasClamm && !initialBatchAvailable) {
      // Recover vaults in one batch after transport/framing failure. This cache
      // also isolates malformed recovery accounts; CLAMM keeps its original failure.
      loadVault = createAccountLoader(boundedSource);
      void loadVault(vaultKeys).catch(() => {});
    }
  }
  const results = await Promise.allSettled(vaultSteps.map(async step =>
    prepareVaultQuote(await loadVault(keysForVault(step)), venues[step.venue], step.operation, now, programs)));
  const vaults = new Map<string, ReturnType<typeof prepareVaultQuote>>();
  const errors = new Map<string, unknown>();
  for (const [index, result] of results.entries()) {
    const step = vaultSteps[index]!;
    if (result.status === "fulfilled") vaults.set(step.id, result.value);
    else errors.set(step.id, result.reason);
  }
  if (candidates.every(route => route.steps.some(step => errors.has(step.id)))) throw errors.values().next().value;
  const clamm = new Map<string, Promise<ReturnType<typeof prepareClammQuote>>>();
  return {
    vault(step: VaultStep) { if (errors.has(step.id)) throw errors.get(step.id); return vaults.get(step.id)!; },
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
