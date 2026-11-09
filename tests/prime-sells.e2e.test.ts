import { MAX_ACCOUNTS_PER_TRANSACTION, RpcConnection, TransactionUtil } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { expect, it, vi } from "vitest";
import { createDirectRfqProvider } from "../examples/aeth-usd.js";
import { compileRouterMessage, createRouterClient, TRANSACTION_SIZE_LIMIT } from "../src/index.js";

const rpcUrl = process.env.ARCH_RPC_URL;
const rfqUrl = process.env.ARCH_RFQ_URL ?? "https://vaults.veloxapi.net/propamm/rfq";

it.skipIf(!rpcUrl).each(["primeBTC", "primeUSD"] as const)("quotes live %s sells using only router defaults", async symbol => {
  const rpc = new RpcConnection(rpcUrl!);
  const source = { getAccounts: vi.fn(async (addresses: readonly string[]) => {
    const accounts = await rpc.getMultipleAccounts(addresses.map(address => base58.decode(address)));
    return accounts.map(account => account === null ? null : {
      ...account, owner: Uint8Array.from(account.owner), data: Uint8Array.from(account.data), utxo: account.utxo ?? "",
    });
  }) };
  const http = createDirectRfqProvider(rfqUrl, async (url, body) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(1800) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`RFQ HTTP ${response.status}: ${raw}`);
    return raw;
  });
  const provider = { quoteExactIn: vi.fn(http.quoteExactIn) };
  const router = createRouterClient({ network: "mainnet", source, directRfqQuoteProvider: provider });
  const user = base58.encode(new Uint8Array(32).fill(1));
  const request = { inputMint: router.mints![symbol], outputMint: router.mints!.aUSD,
    amountIn: symbol === "primeBTC" ? 1000n : 100_000n, slippageBps: 50, user, deadlineMs: Date.now() + 30_000 };
  const quote = await router.quoteExactIn(request);
  expect(provider.quoteExactIn).toHaveBeenCalledExactlyOnceWith(request);
  const result = provider.quoteExactIn.mock.results[0]!;
  if (result.type !== "return") throw new Error("No Prime RFQ");
  const rfq = await result.value; // Surface RFQ errors even when the vault won.
  expect(quote.estimatedAmountOut).toBeGreaterThanOrEqual(rfq.estimatedAmountOut);
  expect(quote.deadlineMs).toBeGreaterThan(Date.now());
  source.getAccounts.mockClear();
  provider.quoteExactIn.mockResolvedValue(rfq);
  const direct = await router.quoteExactIn({ ...request, routePreference: "propamm" });
  expect(source.getAccounts).not.toHaveBeenCalled();
  expect(direct.hops.map(hop => hop.kind)).toEqual(["propamm"]);
  expect(direct.rfq?.quoteId).toBe(rfq.quoteId);
  expect(direct.estimatedAmountOut).toBe(rfq.estimatedAmountOut);
  const message = compileRouterMessage(direct.instructions, user, new Uint8Array(32));
  const bytes = TransactionUtil.serializedSize({ version: 0, message,
    signatures: Array.from({ length: message.header.num_required_signatures }, () => new Uint8Array(64)) });
  expect(bytes).toBeLessThanOrEqual(TRANSACTION_SIZE_LIMIT);
  expect(message.account_keys.length).toBeLessThanOrEqual(MAX_ACCOUNTS_PER_TRANSACTION);
  console.log(symbol, { auto: quote.hops.map(hop => hop.kind), directOutput: direct.estimatedAmountOut.toString(), bytes });
});
