import { describe, expect, it, vi } from "vitest";
import { createRouterClient, SUPPORTED_PAIRS, TESTNET_MINTS } from "../src/index.js";
import { TESTNET } from "../src/config/testnet.js";
import type { QuoteExactInRequest, QuoteForOutputRequest } from "../src/types.js";

const source = () => ({ getAccounts: vi.fn(async () => { throw new Error("Unexpected read"); }) });
const request = {
  inputMint: TESTNET_MINTS.aBTC,
  outputMint: TESTNET_MINTS.aUSD,
  amountIn: 1_000n,
  slippageBps: 50,
  user: "Gezw1yUcDjFhKQoJw6zq7nRJTc1MKhcUipNsUfrVpJKF",
  deadlineMs: 1_800_000_000_123,
};

describe("compact router client", () => {
  it("exposes combined quote methods for either amount entry", () => {
    expect(Object.keys(createRouterClient({ source: source() }))).toEqual(["quoteExactIn", "quoteForOutput"]);
  });

  it.each([0n, -1n, 1n << 64n, 1000, undefined])("rejects invalid receive amount %s before reads", async (amountOut) => {
    const reader = source();
    await expect(createRouterClient({ source: reader }).quoteForOutput({ ...request, amountOut } as QuoteForOutputRequest))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(reader.getAccounts).not.toHaveBeenCalled();
  });

  it.each([
    { amountIn: 0n }, { amountIn: -1n }, { amountIn: 1n << 64n }, { amountIn: 1000 },
    { slippageBps: -1 }, { slippageBps: 10_000 }, { slippageBps: 0.5 },
    { slippageBps: NaN }, { slippageBps: Infinity }, { slippageBps: "50" },
    { deadlineMs: -1 }, { deadlineMs: 0.1 }, { deadlineMs: Number.MAX_SAFE_INTEGER + 1 },
    { deadlineMs: NaN }, { deadlineMs: Infinity }, { deadlineMs: 1n },
    { inputMint: "invalid" }, { outputMint: "111" }, { user: "" }, { user: 42 },
  ])("rejects invalid request %# before reads", async (invalid) => {
    const reader = source();
    await expect(createRouterClient({ source: reader }).quoteExactIn({
      ...request, ...SUPPORTED_PAIRS[0], ...invalid,
    } as QuoteExactInRequest)).rejects.toMatchObject({ name: "RouterSdkError" });
    expect(reader.getAccounts).not.toHaveBeenCalled();
  });

  it.each([
    ...Object.values(TESTNET_MINTS).map((mint) => ({ inputMint: mint, outputMint: mint })),
    { inputMint: TESTNET.routerProgramId, outputMint: TESTNET_MINTS.aUSD },
    { inputMint: TESTNET_MINTS.aUSD, outputMint: TESTNET.routerProgramId },
  ])("rejects unsupported pair $inputMint → $outputMint before reads", async (pair) => {
    const reader = source();
    await expect(createRouterClient({ source: reader }).quoteExactIn({ ...request, ...pair }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    await expect(createRouterClient({ source: reader }).quoteForOutput({ ...request, ...pair, amountOut: 1000n }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_PAIR" });
    expect(reader.getAccounts).not.toHaveBeenCalled();
  });
});
