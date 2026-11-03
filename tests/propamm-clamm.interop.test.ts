import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TransactionUtil } from "@arch-network/arch-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAINNET_AETH_USD as market } from "../src/index.js";
import { NETWORKS } from "../src/config/networks.js";
import { compileRouterMessage } from "../src/utils.js";
import fixtures from "./fixtures/aeth-usd/transactions.json" with { type: "json" };
import { setupComposableAeth, setupComposableAethBuy } from "./fixtures/composable-aeth.js";

const run = promisify(execFile);
const repository = process.env.PROPAMM_REPO;
afterEach(() => { vi.restoreAllMocks(); });

// Explicit opt-in keeps the regular SDK suite independent of a Rust checkout.
describe.skipIf(!repository)("SDK packets against the external PropAMM CLAMM validator", () => {
  it("accepts all eight aETH swap routes and rejects altered terms/programs/oracles", async () => {
    vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms);
    const repo = await realpath(repository!);
    const config = NETWORKS.mainnet;
    const results = [];
    const assets = [market.quoteMint, config.mints.primeUSD, config.mints.aBTC, config.mints.primeBTC];
    const states = [...assets.map(setupComposableAeth), ...assets.map(setupComposableAethBuy)];
    for (const state of states) {
      const quote = await state.client.quoteExactIn(state.request);
      if (quote.execution === "serverTransaction") throw new Error("Expected a router packet");
      const message = compileRouterMessage(quote.instructions, state.request.user, new Uint8Array(32));
      const transaction = { version: 0, message, signatures: [new Uint8Array(64), new Uint8Array(64)] };
      const signedSize = TransactionUtil.serializedSize(transaction);
      expect(signedSize).toBeLessThanOrEqual(4096);
      expect(state.source.getAccounts.mock.calls.length).toBeLessThanOrEqual(2);
      const rfq = await state.directRfqQuoteProvider.quoteExactIn.mock.results[0]!.value;
      const data = rfq.transaction.message.instructions[0]!.data;
      const readU64 = (offset: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true).toString();
      const rfqOffset = 26 + quote.hops.slice(0, quote.hops.findIndex(hop => hop.kind === "propamm"))
        .reduce((length, hop) => length + (hop.kind === "clamm" ? 19 : 1), 0);
      results.push({ inputMint: state.request.inputMint, outputMint: state.request.outputMint,
        hops: quote.hops.length, mixed: quote.hops.some(hop => hop.kind === "clamm"),
        rfqFirst: quote.hops[0]!.kind === "propamm", rfqOffset,
        terms: { side: data[1] === 0 ? "buy" : "sell", baseAmount: readU64(2), quoteAmount: readU64(10), expiry: readU64(18), nonce: readU64(26) },
        reads: state.source.getAccounts.mock.calls.length, signedSize, accounts: message.account_keys.length,
        transaction: TransactionUtil.toNumberArray(transaction) });
    }
    const directory = await mkdtemp(join(tmpdir(), "router-propamm-clamm-"));
    try {
      await mkdir(join(directory, "src"));
      const harness = await readFile(new URL("./fixtures/propamm-clamm/verify.rs", import.meta.url), "utf8");
      await writeFile(join(directory, "src/main.rs"), harness.replace("__VALIDATOR_PATH__", JSON.stringify(join(repo, "server/src/router_transaction.rs"))));
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
serde_json = "1"
propammprogram = { path = ${JSON.stringify(join(repo, "program"))}, features = ["no-entrypoint"] }
propamm-config = { path = ${JSON.stringify(join(repo, "config"))} }
`);
      const packets = join(directory, "packets.json");
      await writeFile(packets, JSON.stringify({
        base: market.baseMint, quote: market.quoteMint, user: fixtures.user,
        router: config.programs.routerProgramId, vault: config.programs.vaultProgramId,
        clamm: config.programs.clammProgramId, pool: config.venues.clamm.address,
        program: market.programId, config: market.config, maker: market.quoteSigner, now: fixtures.now_ms, results,
      }));
      const result = await run("cargo", ["run", "--offline", "--quiet", "--manifest-path", join(directory, "Cargo.toml"), "--", packets], {
        env: { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), "router-propamm-clamm-target"), RUSTFLAGS: "--cap-lints=allow" },
        timeout: 180_000, maxBuffer: 1024 * 1024,
      });
      expect(result.stdout.match(/^accepted /gm)).toHaveLength(8);
      console.log(result.stdout.trim());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 190_000);
});
