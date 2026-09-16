import { SanitizedMessageUtil } from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { TESTNET, TESTNET_MINTS } from "../../src/config/testnet.js";
import { buildInstructionBundle } from "../../src/transactions/instructions.js";
import { buildInputs, expectedInstructions, fixtures, namedFixture } from "./fixtures.js";

describe("router instruction bundles", () => {
  it.each(fixtures)("matches Rust bytes, accounts, and privileges: $name", (fixture) => {
    const { resolved, request } = buildInputs(fixture);
    const instructions = buildInstructionBundle(resolved, request, TESTNET);
    expect(instructions).toEqual(expectedInstructions(fixture));
    const message = SanitizedMessageUtil.createSanitizedMessage([...instructions], base58.decode(request.user), new Uint8Array(32));
    if (typeof message === "string") throw new Error(message);
    expect(message.account_keys).toHaveLength(fixture.expectedAccountKeys);
    expect(message.header.num_required_signatures).toBe(1);
    expect(message.instructions[1]!.accounts).toHaveLength(instructions[1]!.accounts.length);
  });

  it("preserves duplicate venue slots while compilation merges keys and privileges", () => {
    const { resolved, request } = buildInputs(namedFixture("three-hop-usd-shared"));
    const instructions = buildInstructionBundle(resolved, request, TESTNET);
    const message = SanitizedMessageUtil.createSanitizedMessage([...instructions], base58.decode(request.user), new Uint8Array(32));
    if (typeof message === "string") throw new Error(message);
    const router = message.instructions[1]!;
    expect(router.accounts).toHaveLength(35);
    expect(message.account_keys).toHaveLength(31);
    expect(router.accounts[15]).toBe(router.accounts[16]); // Source fee destinations.
    expect(router.accounts[30]).toBe(router.accounts[31]); // Target fee destinations.
    expect(router.accounts[17]).toBe(router.accounts[32]); // Shared vault event authority.
    expect(router.accounts[18]).toBe(router.accounts[34]); // Redeem system account and trailer.
    expect(message.instructions[0]!.accounts[0]).toBe(message.instructions[0]!.accounts[2]);
    // The input share mint is read-only in ATA creation and writable in Redeem.
    const inputMintIndex = router.accounts[2]!;
    expect(message.instructions[0]!.accounts[3]).toBe(inputMintIndex);
    expect(inputMintIndex).toBeLessThan(message.account_keys.length - message.header.num_readonly_unsigned_accounts);
  });

  it("encodes the resolved minimum and exact millisecond deadline without applying slippage again", () => {
    const { resolved, request } = buildInputs(namedFixture("direct-mint-usd"));
    const instructions = buildInstructionBundle(
      { ...resolved, quote: { ...resolved.quote, minAmountOut: 73n } },
      { ...request, slippageBps: 50, deadlineMs: 1_800_000_000_987 }, TESTNET,
    );
    const wire = instructions[1]!.data;
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    expect(view.getBigUint64(1, true)).toBe(request.amountIn);
    expect(view.getBigUint64(9, true)).toBe(73n);
    expect(view.getBigUint64(17, true)).toBe(1_800_000_000_987n);
  });

  it("keeps an intermediate Mint output writable when a following pool trades that share mint", () => {
    const mint = buildInputs(namedFixture("direct-mint-usd"));
    const swap = buildInputs(namedFixture("direct-clamm-usd")).resolved.hops[0]!;
    // A hypothetical configured share-token pool: construction consumes resolved
    // metadata; pool/mint relationship validation belongs to the venue adapter.
    const next = { ...swap, quote: { ...swap.quote, step: { ...swap.quote.step, inputMint: TESTNET_MINTS.primeUSD } } };
    const hops = [mint.resolved.hops[0]!, next];
    const resolved = {
      quote: {
        ...mint.resolved.quote,
        route: { ...mint.resolved.quote.route, outputMint: TESTNET_MINTS.aBTC, steps: hops.map((hop) => hop.quote.step) },
        hops: hops.map((hop) => hop.quote),
      },
      hops,
    };
    const instructions = buildInstructionBundle(resolved, { ...mint.request, outputMint: TESTNET_MINTS.aBTC }, TESTNET);
    expect(instructions[1]!.accounts[4]).toEqual({ pubkey: base58.decode(TESTNET_MINTS.primeUSD), is_signer: false, is_writable: true });
    expect(instructions[1]!.accounts[2]!.is_writable).toBe(false);
    expect(instructions[1]!.accounts[6]!.is_writable).toBe(false);
  });

  it("assembles synchronously without fetching state or a blockhash", () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected network request"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const { resolved, request } = buildInputs(namedFixture("three-hop-btc-shared"));
      expect(Array.isArray(buildInstructionBundle(resolved, request, TESTNET))).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects mismatched request amounts, endpoints, and deployments", () => {
    const { resolved, request } = buildInputs(namedFixture("direct-mint-usd"));
    for (const change of [{ amountIn: request.amountIn + 1n }, { inputMint: TESTNET_MINTS.aBTC }, { outputMint: TESTNET_MINTS.primeBTC }]) {
      expect(() => buildInstructionBundle(resolved, { ...request, ...change }, TESTNET)).toThrow(
        expect.objectContaining({ code: "QUOTE_MISMATCH" }),
      );
    }
    expect(() => buildInstructionBundle(resolved, request, { ...TESTNET, routerProgramId: TESTNET.vaultProgramId })).toThrow(
      expect.objectContaining({ code: "QUOTE_MISMATCH" }),
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects an unrepresentable deadline: %s", (deadlineMs) => {
    const { resolved, request } = buildInputs(namedFixture("direct-mint-usd"));
    expect(() => buildInstructionBundle(resolved, { ...request, deadlineMs }, TESTNET)).toThrow(
      expect.objectContaining({ code: "INVALID_INSTRUCTION" }),
    );
  });

  it("rejects mismatched resolved step counts and operations", () => {
    const { resolved, request } = buildInputs(namedFixture("direct-mint-usd"));
    expect(() => buildInstructionBundle({ ...resolved, hops: [] }, request, TESTNET)).toThrow(
      expect.objectContaining({ code: "QUOTE_MISMATCH" }),
    );
    const hop = resolved.hops[0]!;
    expect(() => buildInstructionBundle({ ...resolved, hops: [{ ...hop, args: { kind: "vaultRedeem" } }] }, request, TESTNET)).toThrow(
      expect.objectContaining({ code: "QUOTE_MISMATCH" }),
    );
  });

  it("rejects discontinuous paths, repeated mints, and a wrong final mint", () => {
    for (const change of [
      { index: 1, inputMint: TESTNET_MINTS.aBTC },
      { index: 1, outputMint: TESTNET_MINTS.primeUSD },
      { index: 2, outputMint: TESTNET.routerProgramId },
    ]) {
      const { resolved, request } = buildInputs(namedFixture("three-hop-usd-shared"));
      const { index, ...fields } = change;
      const steps = resolved.quote.route.steps.map((step, i) => i === index ? { ...step, ...fields } : step);
      const modified = {
        ...resolved,
        quote: { ...resolved.quote, route: { ...resolved.quote.route, steps } },
        hops: resolved.hops.map((hop, i) => ({ ...hop, quote: { ...hop.quote, step: steps[i]! } })),
      };
      expect(() => buildInstructionBundle(modified, request, TESTNET)).toThrow(
        expect.objectContaining({ code: "INVALID_ROUTE" }),
      );
    }
  });

  it.each(["direct-mint-usd", "direct-redeem-usd", "direct-clamm-btc", "clamm-supplements-2"])(
    "rejects missing or surplus venue slots: %s", (name) => {
      const { resolved, request } = buildInputs(namedFixture(name));
      const hop = resolved.hops[0]!;
      for (const accounts of [hop.accounts.slice(1), [...hop.accounts, hop.accounts[0]!]]) {
        expect(() => buildInstructionBundle({ ...resolved, hops: [{ ...hop, accounts }] }, request, TESTNET)).toThrow(
          expect.objectContaining({ code: "INVALID_ACCOUNTS" }),
        );
      }
    },
  );

  it("rejects wrong program identities, malformed keys, and venue privileges", () => {
    const { resolved, request } = buildInputs(namedFixture("direct-redeem-usd"));
    const hop = resolved.hops[0]!;
    for (const [index, patch] of [
      [0, { pubkey: base58.decode(TESTNET.clammProgramId) }],
      [8, { pubkey: base58.decode(TESTNET.tokenProgramId) }],
      [1, { pubkey: new Uint8Array(31) }],
      [1, { is_writable: false }],
      [1, { is_signer: true }],
      [0, { is_writable: true }],
    ] as const) {
      const accounts = hop.accounts.map((meta, i) => i === index ? { ...meta, ...patch } : meta);
      expect(() => buildInstructionBundle({ ...resolved, hops: [{ ...hop, accounts }] }, request, TESTNET)).toThrow(
        expect.objectContaining({ code: "INVALID_ACCOUNTS" }),
      );
    }
  });
});
