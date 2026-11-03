import { MAX_ACCOUNTS_PER_TRANSACTION, RpcConnection, TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { expect, it, vi } from "vitest";
import {
  compileRouterMessage, createRouterClient, MAINNET_AETH_USD as ethUsd, TRANSACTION_SIZE_LIMIT,
  type QuoteExactInRequest, type RouterDataSource,
} from "../src/index.js";
import { createAethUsdRfqProvider } from "../examples/aeth-usd.js";
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
      // Arch SDK batch responses contain JSON number arrays.
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
  // A blockhash is always 32 bytes; these placeholders measure size without signing.
  const message = compileRouterMessage(quote.instructions, user, new Uint8Array(32));
  const signatureCount = message.header.num_required_signatures;
  const signedSize = TransactionUtil.serializedSize({
    version: 0, message,
    signatures: Array.from({ length: signatureCount }, () => new Uint8Array(64)),
  });
  expect(signedSize).toBeLessThanOrEqual(TRANSACTION_SIZE_LIMIT);
  expect(message.account_keys.length).toBeLessThanOrEqual(MAX_ACCOUNTS_PER_TRANSACTION);
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
  console.log(`Transaction size: ${signedSize}/${TRANSACTION_SIZE_LIMIT} bytes (signatures: ${signatureCount})`);
}, 30_000);

const composableAethRoutes = [
  { output: "aUSD", path: ["aETH", "aUSD"], operations: ["propamm"], reads: 0, initialAccounts: 0 },
  { output: "primeUSD", path: ["aETH", "aUSD", "primeUSD"], operations: ["propamm", "vaultMint"], reads: 1, initialAccounts: 4 },
  { output: "aBTC", path: ["aETH", "aUSD", "aBTC"], operations: ["propamm", "clamm"], reads: 2, initialAccounts: 3 },
  { output: "primeBTC", path: ["aETH", "aUSD", "aBTC", "primeBTC"], operations: ["propamm", "clamm", "vaultMint"], reads: 2, initialAccounts: 6 },
] as const;

it.skipIf(!rpcUrl).each(composableAethRoutes)("gets a live mainnet composable aETH → $output quote", async ({ output, path, operations, reads, initialAccounts }) => {
  const rpc = new RpcConnection(rpcUrl!);
  const source = { getAccounts: vi.fn(async (addresses: readonly string[]) => {
    const accounts = await rpc.getMultipleAccounts(addresses.map((address) => base58.decode(address)));
    return accounts.map((account) => account === null ? null : {
      ...account, owner: Uint8Array.from(account.owner), data: Uint8Array.from(account.data), utxo: account.utxo ?? "",
    });
  }) };
  const post = vi.fn(async (url: string, body: string) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(1800) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`RFQ HTTP ${response.status}: ${raw}`);
    return raw;
  });
  const httpProvider = createAethUsdRfqProvider(rfqUrl, post);
  let originalBytes: string | undefined;
  const directRfqQuoteProvider = { quoteExactIn: vi.fn(async (request: QuoteExactInRequest) => {
    const rfq = await httpProvider.quoteExactIn(request);
    originalBytes = hex.encode(TransactionUtil.serialize(rfq.transaction));
    return rfq;
  }) };
  const router = createRouterClient({ source, network: "mainnet", directRfqQuoteProvider, composableAethSells: true });
  const request = { inputMint: ethUsd.baseMint, outputMint: router.mints![output], amountIn: 1_000_000n,
    user, slippageBps: 100, deadlineMs: Date.now() + 30_000 };
  const quote = await router.quoteExactIn(request);
  if (quote.execution === "serverTransaction") throw new Error("Expected composable sell instructions");
  expect(directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith({ ...request, outputMint: ethUsd.quoteMint });
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0]![0]).toBe(`${rfqUrl.replace(/\/+$/, "")}/quote`);
  expect(source.getAccounts).toHaveBeenCalledTimes(reads);
  if (reads > 0) expect(source.getAccounts.mock.calls[0]![0]).toHaveLength(initialAccounts);
  if (reads === 2) {
    const ticks = source.getAccounts.mock.calls[1]![0];
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(3);
  }
  const addresses = source.getAccounts.mock.calls.flatMap(([keys]) => keys);
  expect(new Set(addresses).size).toBe(addresses.length);
  const rfqCall = directRfqQuoteProvider.quoteExactIn.mock.results[0];
  if (rfqCall?.type !== "return") throw new Error("Native aETH sell RFQ was not requested");
  const rfq = await rfqCall.value;
  expect(hex.encode(TransactionUtil.serialize(rfq.transaction))).toBe(originalBytes);
  expect(rfq.transaction.signatures).toEqual([]);
  expect(quote.rfq).toEqual({ quoteId: rfq.quoteId });
  expect(quote.inputMint).toBe(request.inputMint);
  expect(quote.outputMint).toBe(request.outputMint);
  expect(quote.amountIn).toBe(request.amountIn);
  expect(quote.hops.map((hop) => hop.kind)).toEqual(operations);
  const mints = { ...router.mints!, aETH: ethUsd.baseMint };
  expect([quote.inputMint, ...quote.hops.map((hop) => hop.outputMint)]).toEqual(path.map((mint) => mints[mint]));
  expect(quote.hops[0]!.estimatedAmountOut).toBe(rfq.estimatedAmountOut);
  for (const [index, hop] of quote.hops.entries()) {
    const previous = quote.hops[index - 1];
    expect(hop.inputMint).toBe(previous?.outputMint ?? request.inputMint);
    expect(hop.amountIn).toBe(previous?.estimatedAmountOut ?? request.amountIn);
    expect(hop.estimatedAmountOut).toBeGreaterThan(0n);
  }
  expect(quote.hops.at(-1)!.estimatedAmountOut).toBe(quote.estimatedAmountOut);
  expect(quote.estimatedAmountOut).toBeGreaterThan(0n);
  expect(quote.minAmountOut).toBe(quote.estimatedAmountOut * 9900n / 10_000n);
  expect(quote.deadlineMs).toBeGreaterThan(Date.now());
  expect(quote.deadlineMs).toBeLessThanOrEqual(request.deadlineMs);
  expect(BigInt(quote.deadlineMs)).toBeLessThanOrEqual(rfq.expiresAtMs);
  // Preserve the native compact quote in the first router hop, including its
  // side, amounts, expiry and nonce; only the enclosing router message is new.
  expect(quote.instructions[1]!.data.subarray(27, 60)).toEqual(rfq.transaction.message.instructions[0]!.data.subarray(1, 34));
  const message = compileRouterMessage(quote.instructions, user, new Uint8Array(32));
  const signedSize = TransactionUtil.serializedSize({ version: 0, message, signatures: [new Uint8Array(64), new Uint8Array(64)] });
  expect(message.header).toMatchObject({ num_required_signatures: 2, num_readonly_signed_accounts: 1 });
  expect(message.account_keys.slice(0, 2).map(base58.encode)).toEqual([user, ethUsd.quoteSigner]);
  expect(message.account_keys.length).toBeLessThanOrEqual(MAX_ACCOUNTS_PER_TRANSACTION);
  expect(signedSize).toBeLessThanOrEqual(TRANSACTION_SIZE_LIMIT);
  console.log(`Composable aETH → ${output}: ${source.getAccounts.mock.calls.length} account-reader calls, ${signedSize} signed bytes`);
}, 30_000);

it.skipIf(!rpcUrl).each([
  { input: "aUSD", output: "aETH", inputMint: ethUsd.quoteMint, outputMint: ethUsd.baseMint,
    amountIn: 1_000_000n, kind: "treasuryMint" }, // 1 aUSD (6 decimals).
  { input: "aETH", output: "aUSD", inputMint: ethUsd.baseMint, outputMint: ethUsd.quoteMint,
    amountIn: 1_000_000n, kind: "propamm" }, // 0.001 aETH (9 decimals).
] as const)("gets a live mainnet $input → $output quote", async ({ input, output, inputMint, outputMint, amountIn, kind }) => {
  const source = { getAccounts: vi.fn(async () => { throw new Error("Unexpected ETH/USD account read"); }) };
  const propAmmQuoteProvider = { quoteExactIn: vi.fn(async () => { throw new Error("Unexpected BTC/USD RFQ"); }) };
  const post = vi.fn(async (url: string, body: string) => {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(1800),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`RFQ HTTP ${response.status}: ${text}`);
    return text;
  });
  const httpProvider = createAethUsdRfqProvider(rfqUrl, post);
  let originalBytes: string | undefined;
  const directRfqQuoteProvider = {
    quoteExactIn: vi.fn(async (request: QuoteExactInRequest) => {
      const rfq = await httpProvider.quoteExactIn(request);
      originalBytes = hex.encode(TransactionUtil.serialize(rfq.transaction));
      return rfq;
    }),
  };
  const router = createRouterClient({ network: "mainnet", source, propAmmQuoteProvider, directRfqQuoteProvider });
  const request = { inputMint, outputMint, amountIn, user, slippageBps: 100, deadlineMs: Date.now() + 30_000 };
  const quote = await router.quoteExactIn(request);

  expect(directRfqQuoteProvider.quoteExactIn).toHaveBeenCalledExactlyOnceWith(request);
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0]![0]).toBe(`${rfqUrl.replace(/\/+$/, "")}/quote`);
  expect(source.getAccounts).not.toHaveBeenCalled();
  expect(propAmmQuoteProvider.quoteExactIn).not.toHaveBeenCalled();
  if (quote.execution !== "serverTransaction") throw new Error("Expected an ETH/USD server transaction");
  const rfqCall = directRfqQuoteProvider.quoteExactIn.mock.results[0];
  if (rfqCall?.type !== "return") throw new Error("Direct RFQ was not requested");
  const rfq = await rfqCall.value;
  expect(quote.transaction).toBe(rfq.transaction);
  expect(hex.encode(TransactionUtil.serialize(quote.transaction))).toBe(originalBytes);
  expect(quote.transaction.signatures).toEqual([]);
  expect(quote.rfq.quoteId).toBe(rfq.quoteId);
  expect(quote.inputMint).toBe(inputMint);
  expect(quote.outputMint).toBe(outputMint);
  expect(quote.amountIn).toBe(amountIn);
  expect(quote.estimatedAmountOut).toBeGreaterThan(0n);
  expect(quote.minAmountOut).toBeGreaterThan(0n);
  expect(quote.minAmountOut).toBeLessThanOrEqual(quote.estimatedAmountOut);
  expect(quote.deadlineMs).toBeGreaterThan(Date.now());
  expect(quote.hops).toEqual([{ kind, inputMint, outputMint, amountIn, estimatedAmountOut: quote.estimatedAmountOut }]);

  // Measure the original server message, reserving both signatures without recompiling it.
  const signatureCount = quote.transaction.message.header.num_required_signatures;
  expect(signatureCount).toBe(2);
  const signedSize = TransactionUtil.serializedSize({
    ...quote.transaction, signatures: Array.from({ length: signatureCount }, () => new Uint8Array(64)),
  });
  expect(signedSize).toBeLessThanOrEqual(TRANSACTION_SIZE_LIMIT);
  expect(quote.transaction.message.account_keys.length).toBeLessThanOrEqual(MAX_ACCOUNTS_PER_TRANSACTION);
  console.log(`Route: ${input} --[${quote.hops[0]!.kind}]--> ${output}`);
  console.table(quote.hops.map((hop, index) => ({
    hop: index + 1, kind: hop.kind, input, output,
    amountInRaw: hop.amountIn.toString(), estimatedAmountOutRaw: hop.estimatedAmountOut.toString(),
  })));
  console.log(`Estimated ${output} output, raw:`, quote.estimatedAmountOut.toString());
  console.log(`Transaction size: ${signedSize}/${TRANSACTION_SIZE_LIMIT} bytes (signatures: ${signatureCount})`);
}, 30_000);
