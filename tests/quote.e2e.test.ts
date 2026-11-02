import { RpcConnection } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { expect, it, vi } from "vitest";
import { createRouterClient, type RouterDataSource } from "../src/index.js";
import { createMainnetPropAmmRfqProvider } from "./helpers/propamm-rfq.js";

const rpcUrl = process.env.ARCH_RPC_URL;
const rfqUrl = process.env.ARCH_RFQ_URL ?? "https://vaults.veloxapi.net/propamm/rfq";

it.skipIf(!rpcUrl).each([
  { input: "aUSD", output: "aBTC", amountIn: 1_000_000n }, // 1 aUSD (6 decimals).
  { input: "aBTC", output: "aUSD", amountIn: 1_000n }, // 0.00001 aBTC (8 decimals).
] as const)("gets a live mainnet $input → $output quote", async ({ input, output, amountIn }) => {
  const rpc = new RpcConnection(rpcUrl!);
  const source: RouterDataSource = {
    async getAccounts(addresses) {
      const accounts = await rpc.getMultipleAccounts(
        addresses.map((address) => base58.decode(address)),
      );
      // arch-sdk 0.0.28 leaves batch response bytes as JSON number arrays.
      return accounts.map((account) => account === null ? null : {
        ...account,
        owner: Uint8Array.from(account.owner),
        data: Uint8Array.from(account.data),
        // Current RPC omits this legacy SDK field; quoting does not use it.
        utxo: account.utxo ?? "",
      });
    },
  };

  const httpProvider = createMainnetPropAmmRfqProvider(rfqUrl);
  const propAmmQuoteProvider = { quoteExactIn: vi.fn(httpProvider.quoteExactIn) };
  const router = createRouterClient({ network: "mainnet", source, propAmmQuoteProvider });
  const mints = router.mints!;
  const quote = await router.quoteExactIn({
    inputMint: mints[input],
    outputMint: mints[output],
    amountIn,
    slippageBps: 50, // 0.5%.
    user: base58.encode(new Uint8Array(32).fill(1)), // Quote-only dummy public key.
    deadlineMs: Date.now() + 120_000,
  });

  expect(propAmmQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({
    inputMint: mints[input], outputMint: mints[output], amountIn,
    user: base58.encode(new Uint8Array(32).fill(1)),
  });
  const rfqCall = propAmmQuoteProvider.quoteExactIn.mock.results[0];
  if (rfqCall?.type !== "return") throw new Error("PropAMM RFQ was not requested");
  // Surface HTTP/decoding failures even when the SDK successfully falls back to CLAMM.
  const rfq = await rfqCall.value;
  expect(rfq.terms.expiryMs).toBeGreaterThan(BigInt(Date.now()));
  expect(quote.estimatedAmountOut).toBeGreaterThanOrEqual(rfq.estimatedAmountOut);

  expect(quote.inputMint).toBe(mints[input]);
  expect(quote.outputMint).toBe(mints[output]);
  expect(quote.amountIn).toBe(amountIn);
  expect(quote.estimatedAmountOut).toBeGreaterThan(0n);
  expect(quote.minAmountOut).toBeGreaterThan(0n);
  expect(quote.minAmountOut).toBeLessThanOrEqual(quote.estimatedAmountOut);

  if (quote.execution === "serverTransaction") {
    throw new Error("Expected a router quote");
  }
  expect(quote.instructions.length).toBeGreaterThan(0);

  const symbols = new Map(Object.entries(mints).map(([symbol, mint]) => [mint, symbol]));
  const symbol = (mint: string) => symbols.get(mint) ?? mint;
  console.log(`PropAMM RFQ estimated ${output} output, raw:`, rfq.estimatedAmountOut.toString());
  console.log("Route:", [
    symbol(quote.inputMint),
    ...quote.hops.map((hop) => `--[${hop.kind}]--> ${symbol(hop.outputMint)}`),
  ].join(" "));
  console.log(`Estimated ${output} output, raw:`, quote.estimatedAmountOut.toString());
}, 30_000);
