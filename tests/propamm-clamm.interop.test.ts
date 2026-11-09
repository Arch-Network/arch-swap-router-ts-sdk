import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TransactionUtil } from "@arch-network/arch-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAINNET_AETH_USD as market, MAINNET_AHYPE_USD as hypeMarket } from "../src/index.js";
import { NETWORKS } from "../src/config/networks.js";
import { compileRouterMessage } from "../src/utils.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };
import { setupComposableAeth, setupComposableAethBuy, setupComposableAethTreasuryBuy } from "./fixtures/composable-aeth.js";
import { setupComposableAhype } from "./fixtures/composable-ahype.js";

const run = promisify(execFile);
const repository = process.env.PROPAMM_REPO;
afterEach(() => { vi.restoreAllMocks(); });

// Explicit opt-in keeps the regular SDK suite independent of a Rust checkout.
describe.skipIf(!repository)("SDK packets against the external PropAMM validator", () => {
  it("accepts native and authorized treasury routes for aETH and aHYPE, rejecting altered packets", async () => {
    vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms);
    const repo = await realpath(repository!);
    const config = NETWORKS.mainnet;
    const results = [];
    const assets = [market.quoteMint, config.mints.primeUSD, config.mints.aBTC, config.mints.primeBTC];
    const states = [
      ...assets.map(mint => ({ state: setupComposableAeth(mint), treasury: false, allowanceBps: 50, deployment: market })),
      ...assets.map(mint => ({ state: setupComposableAethBuy(mint), treasury: false, allowanceBps: 50, deployment: market })),
      ...[false, true].flatMap(bounded => assets.map(mint => ({
        state: setupComposableAethTreasuryBuy(mint, bounded), treasury: true, allowanceBps: bounded ? 50 : 0, deployment: market,
      }))),
      ...assets.map(mint => ({ state: setupComposableAhype(mint, "sell"), treasury: false, allowanceBps: 50, deployment: hypeMarket })),
      ...assets.map(mint => ({ state: setupComposableAhype(mint, "buy", true, true), treasury: false, allowanceBps: 50, deployment: hypeMarket })),
      ...[false, true].flatMap(bounded => assets.map(mint => ({
        state: setupComposableAhype(mint, "buy", bounded), treasury: true, allowanceBps: bounded ? 50 : 0, deployment: hypeMarket,
      }))),
    ];
    for (const { state, treasury, allowanceBps, deployment } of states) {
      const quote = await state.client.quoteExactIn(state.request);

      const message = compileRouterMessage(quote.instructions, state.request.user, new Uint8Array(32));
      const transaction = { version: 0, message, signatures: [new Uint8Array(64), new Uint8Array(64)] };
      const signedSize = TransactionUtil.serializedSize(transaction);
      expect(signedSize).toBeLessThanOrEqual(4096);
      expect(state.source.getAccounts.mock.calls.length).toBeLessThanOrEqual(2);
      const rfq = await state.directRfqQuoteProvider.quoteExactIn.mock.results[0]!.value;
      const data = rfq.transaction.message.instructions[treasury ? 1 : 0]!.data;
      const readU64 = (offset: number, bytes = data) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true).toString();
      const rfqOffset = 26 + quote.hops.slice(0, quote.hops.findIndex(hop => hop.kind === "propamm" || hop.kind === "treasuryMint"))
        .reduce((length, hop) => length + (hop.kind === "clamm" ? 19 : 1), 0);
      results.push({ inputMint: state.request.inputMint, outputMint: state.request.outputMint,
        baseMint: deployment.baseMint, quoteMint: deployment.quoteMint,
        treasury, allowanceBps,
        hops: quote.hops.length, mixed: quote.hops.some(hop => hop.kind === "clamm"),
        rfqFirst: quote.hops[0]!.kind === "propamm" || quote.hops[0]!.kind === "treasuryMint", rfqOffset,
        terms: { side: treasury || data[1] === 0 ? "buy" : "sell",
          baseAmount: readU64(treasury ? 33 : 2), quoteAmount: treasury ? readU64(1, rfq.transaction.message.instructions[0]!.data) : readU64(10),
          expiry: rfq.expiresAtMs.toString(), nonce: treasury ? "0" : readU64(26) },
        authorization: rfq.treasuryAuthorization ? { version: rfq.treasuryAuthorization.version,
          min_amount_in: rfq.treasuryAuthorization.minAmountIn.toString(),
          max_amount_in: rfq.treasuryAuthorization.maxAmountIn.toString() } : null,
        nativeTransaction: TransactionUtil.toNumberArray(rfq.transaction),
        reads: state.source.getAccounts.mock.calls.length, signedSize, accounts: message.account_keys.length,
        transaction: TransactionUtil.toNumberArray(transaction) });
    }
    const directory = await mkdtemp(join(tmpdir(), "router-propamm-clamm-"));
    try {
      await mkdir(join(directory, "src"));
      const harness = await readFile(new URL("./fixtures/propamm-clamm/verify.rs", import.meta.url), "utf8");
      await writeFile(join(directory, "src/main.rs"), harness
        .replace("__VALIDATOR_PATH__", JSON.stringify(join(repo, "server/src/router_transaction.rs")))
        .replace("__TREASURY_ROUTING_PATH__", JSON.stringify(join(repo, "server/src/treasury_routing.rs")))
        .replace("__TREASURY_MINT_PATH__", JSON.stringify(join(repo, "server/src/treasury_mint.rs"))));
      await writeFile(join(directory, "Cargo.toml"), `[package]
name = "verify-sdk-propamm-clamm"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
arch_program = "=0.13.0"
arch_sdk = "=0.13.0"
apl-token = { version = "=0.13.0", features = ["no-entrypoint"] }
apl-associated-token-account = { version = "=0.13.0", features = ["no-entrypoint"] }
borsh = { version = "1.5", features = ["derive"] }
bs58 = "0.5"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
propammprogram = { path = ${JSON.stringify(join(repo, "program"))}, features = ["no-entrypoint"] }
propamm-config = { path = ${JSON.stringify(join(repo, "config"))} }
`);
      const packets = join(directory, "packets.json");
      await writeFile(packets, JSON.stringify({
        base: market.baseMint, quote: market.quoteMint, user: fixtures.user,
        router: config.programs.routerProgramId, vault: config.programs.vaultProgramId,
        clamm: config.programs.clammProgramId, pool: config.venues.clamm.address,
        program: market.programId, config: market.config, maker: market.quoteSigner,
        treasuryAuthority: market.treasuryAuthority, bridge: market.bridgeProgramId, now: fixtures.now_ms, results,
      }));
      const result = await run("cargo", ["run", "--offline", "--quiet", "--manifest-path", join(directory, "Cargo.toml"), "--", packets], {
        env: { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), "router-propamm-clamm-target"), RUSTFLAGS: "--cap-lints=allow" },
        timeout: 180_000, maxBuffer: 1024 * 1024,
      });
      expect(result.stdout.match(/^accepted native /gm)).toHaveLength(16);
      expect(result.stdout.match(/^accepted treasury /gm)).toHaveLength(16);
      console.log(result.stdout.trim());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 190_000);
});
