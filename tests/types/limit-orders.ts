import {
  buildCancelLimitOrderInstruction, buildCreateLimitOrderInstruction, generateLimitOrderId, loadLimitOrder, previewLimitOrder,
  type LimitOrderProvider, type RouterDataSource,
} from "../../src/index.js";

// Checked by tsc only; no server, wallet or transaction execution.
export async function limitOrderLifecycle(source: RouterDataSource, provider: LimitOrderProvider, owner: string) {
  const { markets, fillFeeLamports } = await provider.config();
  const market = markets[0]!;
  const { minOutputAmount } = previewLimitOrder({ market, side: "buy", inputAmount: market.minBuyInput, limitPrice: "1", fillFeeLamports });
  // @ts-expect-error Decimals come from the market entry.
  previewLimitOrder({ market, side: "buy", inputAmount: 1n, limitPrice: "1", fillFeeLamports, baseDecimals: 8 });
  const common = {
    network: "mainnet", owner, market, side: "buy", inputAmount: market.minBuyInput,
    orderId: generateLimitOrderId(), fillAllowanceLamports: fillFeeLamports,
  } as const;
  const { order } = buildCreateLimitOrderInstruction({ ...common, limitPrice: "100000", baseDecimals: 8, quoteDecimals: 6 });
  buildCreateLimitOrderInstruction({ ...common, minOutputAmount: 1n });
  // @ts-expect-error A limit price needs both token decimals.
  buildCreateLimitOrderInstruction({ ...common, limitPrice: "1" });
  // @ts-expect-error Supply either a limit price or a minimum output, not both.
  buildCreateLimitOrderInstruction({ ...common, limitPrice: "1", baseDecimals: 8, quoteDecimals: 6, minOutputAmount: 1n });
  // @ts-expect-error One of the two is required.
  buildCreateLimitOrderInstruction(common);
  const account = await loadLimitOrder(source, order, { network: "mainnet" });
  if (account?.status === "open") buildCancelLimitOrderInstruction(account, { network: "mainnet" });
  const { orders, nextCursor } = await provider.list({ owner, status: "closed", limit: 20 });
  const fill = await provider.fill({ order: orders[0]!.order, payer: owner });
  return { minOutputAmount, nextCursor, payerSlot: fill.transaction.signatures[fill.payerSignatureIndex] };
}
