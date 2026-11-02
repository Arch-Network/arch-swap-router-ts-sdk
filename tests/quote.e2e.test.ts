import { RpcConnection } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { expect, it, vi } from "vitest";
import { createRouterClient, type RouterDataSource } from "../src/index.js";
import { createMainnetPropAmmRfqProvider } from "./helpers/propamm-rfq.js";

const rpcUrl = process.env.ARCH_RPC_URL;
const rfqUrl = process.env.ARCH_RFQ_URL ?? "https://vaults.veloxapi.net/propamm/rfq";
const amounts = { aUSD: 1_000_000n, aBTC: 1_000n, primeUSD: 1_000_000n, primeBTC: 1_000n };
const user = base58.encode(new Uint8Array(32).fill(1)); // Quote-only dummy public key.

// Explicit expectations cover every directed pair, independently of SDK route metadata.
const routes = [
  { path: ["aUSD", "aBTC"], operations: ["swap"] },
  { path: ["aBTC", "aUSD"], operations: ["swap"] },
  { path: ["aBTC", "primeBTC"], operations: ["vaultMint"] },
  { path: ["primeBTC", "aBTC"], operations: ["vaultRedeem"] },
  { path: ["aUSD", "primeUSD"], operations: ["vaultMint"] },
  { path: ["primeUSD", "aUSD"], operations: ["vaultRedeem"] },
  { path: ["primeBTC", "aBTC", "aUSD"], operations: ["vaultRedeem", "swap"] },
  { path: ["aUSD", "aBTC", "primeBTC"], operations: ["swap", "vaultMint"] },
  { path: ["primeUSD", "aUSD", "aBTC"], operations: ["vaultRedeem", "swap"] },
  { path: ["aBTC", "aUSD", "primeUSD"], operations: ["swap", "vaultMint"] },
  { path: ["primeBTC", "aBTC", "aUSD", "primeUSD"], operations: ["vaultRedeem", "swap", "vaultMint"] },
  { path: ["primeUSD", "aUSD", "aBTC", "primeBTC"], operations: ["vaultRedeem", "swap", "vaultMint"] },
] as const;

it.skipIf(!rpcUrl).each(routes.map((route) => ({
  ...route, input: route.path[0], output: route.path[route.path.length - 1]!,
})))("gets a live mainnet $input → $output quote", async ({ input, output, path, operations }) => {
  const amountIn = amounts[input]; // USD tokens use 6 decimals; BTC tokens use 8.
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
    user,
    deadlineMs: Date.now() + 120_000,
  });

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
  expect(quote.hops.map((hop) => hop.kind === "clamm" || hop.kind === "propamm" ? "swap" : hop.kind))
    .toEqual(operations);
  expect([quote.inputMint, ...quote.hops.map((hop) => hop.outputMint)])
    .toEqual(path.map((mint) => mints[mint]));
  for (const [index, hop] of quote.hops.entries()) {
    const previous = quote.hops[index - 1];
    expect(hop.inputMint).toBe(previous?.outputMint ?? quote.inputMint);
    expect(hop.amountIn).toBe(previous?.estimatedAmountOut ?? amountIn);
    expect(hop.estimatedAmountOut).toBeGreaterThan(0n);
  }
  expect(quote.hops.at(-1)!.estimatedAmountOut).toBe(quote.estimatedAmountOut);

  const symbols = new Map(Object.entries(mints).map(([symbol, mint]) => [mint, symbol]));
  const symbol = (mint: string) => symbols.get(mint) ?? mint;
  const swapIndex = operations.findIndex((operation) => operation === "swap");
  if (swapIndex < 0) {
    expect(propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  } else {
    const swap = quote.hops[swapIndex]!;
    // A preceding redemption must supply its net asset output, not the share input.
    expect(propAmmQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({
      inputMint: swap.inputMint, outputMint: swap.outputMint, amountIn: swap.amountIn, user,
    });
    const rfqCall = propAmmQuoteProvider.quoteExactIn.mock.results[0];
    if (rfqCall?.type !== "return") throw new Error("PropAMM RFQ was not requested");
    // Surface RFQ failures even when the SDK successfully falls back to CLAMM.
    const rfq = await rfqCall.value;
    expect(rfq.terms.expiryMs).toBeGreaterThan(BigInt(Date.now()));
    if (quote.rfq) {
      expect(quote.rfq.quoteId).toBe(rfq.quoteId);
      expect(swap.kind).toBe("propamm");
      expect(swap.estimatedAmountOut).toBe(rfq.estimatedAmountOut);
    } else {
      expect(swap.kind).toBe("clamm");
    }
    // With a vault suffix, RFQ output is underlying assets and final output is
    // shares; compare raw estimates only when the swap is the final hop.
    if (swapIndex === quote.hops.length - 1) {
      expect(quote.estimatedAmountOut).toBeGreaterThanOrEqual(rfq.estimatedAmountOut);
    }
    console.log(`PropAMM RFQ estimated ${symbol(swap.outputMint)} output, raw:`, rfq.estimatedAmountOut.toString());
  }
  console.log("Route:", [
    symbol(quote.inputMint),
    ...quote.hops.map((hop) => `--[${hop.kind}]--> ${symbol(hop.outputMint)}`),
  ].join(" "));
  console.table(quote.hops.map((hop, index) => ({
    hop: index + 1, kind: hop.kind, input: symbol(hop.inputMint), output: symbol(hop.outputMint),
    amountInRaw: hop.amountIn.toString(), estimatedAmountOutRaw: hop.estimatedAmountOut.toString(),
  })));
  console.log(`Estimated ${output} output, raw:`, quote.estimatedAmountOut.toString());
}, 30_000);
