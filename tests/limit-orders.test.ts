import { SanitizedMessageUtil, type Instruction } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import {
  buildCancelLimitOrderInstruction, buildCreateLimitOrderInstruction, compileRouterMessage, decodeLimitOrder,
  deriveAssociatedTokenAddress, deriveLimitOrderAddress, deriveLimitOrderEscrowAddress, encodeCancelLimitOrderData,
  encodeCreateLimitOrderData, generateLimitOrderId, LIMIT_ORDER_ACCOUNT_LEN, LIMIT_ORDER_DEPLOYMENTS, loadLimitOrder,
  minimumOutputAtLimit, previewLimitOrder, RouterSdkError,
  type LimitOrderMarketConfig, type LimitOrderSide, type Network,
} from "../src/index.js";
import { NETWORKS } from "../src/config/networks.js";
import native from "./fixtures/limit-orders/native.json" with { type: "json" };
import idl from "./fixtures/limit-orders/idl.json" with { type: "json" };

type Case = (typeof native.cases)[number];
const cases = native.cases.map((c) => ({ ...c, network: c.network as Network, side: c.side as LimitOrderSide }));
const bytes = (value: string) => hex.decode(value);
const metas = (ix: Instruction) => ix.accounts.map((meta) => ({
  pubkey: base58.encode(meta.pubkey), is_signer: meta.is_signer, is_writable: meta.is_writable,
}));
const expectNative = (ix: Instruction, expected: Case["create"]) => {
  expect(base58.encode(ix.program_id)).toBe(expected.program_id);
  expect(metas(ix)).toEqual(expected.accounts);
  expect(hex.encode(ix.data)).toBe(expected.data_hex);
};
const sdkError = (code: string) => expect.objectContaining({ name: "RouterSdkError", code });

function createRequest(c: (typeof cases)[number]) {
  return {
    network: c.network, owner: c.owner, market: { baseMint: c.base_mint, quoteMint: c.quote_mint },
    side: c.side, inputAmount: BigInt(c.input_amount), orderId: bytes(c.order_id_hex),
    fillAllowanceLamports: BigInt(c.fill_allowance_lamports),
  };
}

describe("limit-order codecs", () => {
  it.each(cases)("encodes $network $side create data and decodes native accounts", (c) => {
    const params = {
      orderId: bytes(c.order_id_hex), side: c.side, inputAmount: BigInt(c.input_amount),
      minOutputAmount: BigInt(c.min_output_amount), fillAllowanceLamports: BigInt(c.fill_allowance_lamports),
    };
    expect(hex.encode(encodeCreateLimitOrderData(params))).toBe(c.create.data_hex);
    expect(encodeCreateLimitOrderData(params)).toHaveLength(58);
    expect(hex.encode(encodeCancelLimitOrderData())).toBe(c.cancel.data_hex);
    const terms = {
      ...params, version: 1, config: c.config, owner: c.owner, baseMint: c.base_mint, quoteMint: c.quote_mint,
      createdAt: BigInt(c.accounts.open.created_at), rentRefund: c.owner,
    };
    const { open, filled, cancelled } = c.accounts;
    expect(bytes(open.data_hex)).toHaveLength(LIMIT_ORDER_ACCOUNT_LEN);
    expect(decodeLimitOrder(bytes(open.data_hex))).toEqual({ ...terms, status: "open", closedAt: 0n, outputAmount: 0n });
    expect(decodeLimitOrder(bytes(filled.data_hex))).toEqual({
      ...terms, status: "filled", closedAt: BigInt(filled.closed_at), outputAmount: BigInt(filled.output_amount),
    });
    expect(decodeLimitOrder(bytes(cancelled.data_hex))).toEqual({
      ...terms, status: "cancelled", closedAt: BigInt(cancelled.closed_at), outputAmount: 0n,
    });
  });

  it("decodes from a subarray without copying neighbouring bytes", () => {
    const data = bytes(cases[0]!.accounts.open.data_hex);
    const padded = new Uint8Array(data.length + 7);
    padded.set(data, 3);
    expect(decodeLimitOrder(padded.subarray(3, 3 + data.length))).toEqual(decodeLimitOrder(data));
  });

  it("rejects wrong length, discriminator, version, status, side, zero amounts and equal mints", () => {
    const data = bytes(cases[1]!.accounts.open.data_hex);
    for (let length = 0; length < data.length; length++) {
      expect(() => decodeLimitOrder(data.slice(0, length))).toThrow(sdkError("INVALID_ACCOUNT"));
    }
    expect(() => decodeLimitOrder(Uint8Array.from([...data, 0]))).toThrow(sdkError("INVALID_ACCOUNT"));
    const mutate = (edit: (copy: Uint8Array) => void) => {
      const copy = data.slice();
      edit(copy);
      return () => decodeLimitOrder(copy);
    };
    for (const [offset, value] of [[0, 0x51], [7, 0x32], [8, 0], [8, 2], [9, 3], [9, 255], [170, 2]] as const) {
      expect(mutate((copy) => { copy[offset] = value; })).toThrow(sdkError("INVALID_ACCOUNT"));
    }
    expect(mutate((copy) => copy.fill(0, 171, 179))).toThrow(/zero input/);
    expect(mutate((copy) => copy.fill(0, 179, 187))).toThrow(/zero input/);
    expect(mutate((copy) => copy.set(copy.slice(106, 138), 138))).toThrow(/same/);
  });

  it("rejects out-of-range create parameters", () => {
    const valid = { orderId: new Uint8Array(32), side: "buy", inputAmount: 1n, minOutputAmount: 1n, fillAllowanceLamports: 0n } as const;
    expect(encodeCreateLimitOrderData(valid)[33]).toBe(0);
    for (const patch of [
      { orderId: new Uint8Array(31) }, { side: "swap" }, { inputAmount: 0n }, { minOutputAmount: 0n },
      { inputAmount: 1n << 64n }, { fillAllowanceLamports: -1n }, { fillAllowanceLamports: 1 },
    ]) {
      expect(() => encodeCreateLimitOrderData({ ...valid, ...patch } as never)).toThrow(sdkError("INVALID_INSTRUCTION"));
    }
  });
});

describe("limit-order PDAs and builders", () => {
  it("uses each network's PropAMM deployment", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const market = NETWORKS[network].propammMarkets[0]!;
      expect(LIMIT_ORDER_DEPLOYMENTS[network]).toEqual({ programId: market.programId, config: market.config });
    }
    expect(() => deriveLimitOrderAddress(cases[0]!.owner, new Uint8Array(32), { network: "devnet" as Network }))
      .toThrow(sdkError("INVALID_NETWORK"));
  });

  it.each(cases)("derives $network $side order, escrow and owner ATAs natively", (c) => {
    const options = { network: c.network };
    const order = deriveLimitOrderAddress(c.owner, bytes(c.order_id_hex), options);
    expect(order).toBe(c.order);
    expect(deriveLimitOrderEscrowAddress(order, options)).toBe(c.escrow);
    const [input, output] = c.side === "buy" ? [c.quote_mint, c.base_mint] : [c.base_mint, c.quote_mint];
    expect(deriveAssociatedTokenAddress(c.owner, input, options)).toBe(c.owner_input_ata);
    expect(deriveAssociatedTokenAddress(c.owner, output, options)).toBe(c.owner_output_ata);
  });

  it.each(cases)("builds the native owner-paid $network $side create and cancel", (c) => {
    const byPrice = buildCreateLimitOrderInstruction({
      ...createRequest(c), limitPrice: c.limit_price, baseDecimals: c.base_decimals, quoteDecimals: c.quote_decimals,
    });
    const byMinimum = buildCreateLimitOrderInstruction({ ...createRequest(c), minOutputAmount: BigInt(c.min_output_amount) });
    for (const result of [byPrice, byMinimum]) {
      expect(result).toMatchObject({ order: c.order, escrow: c.escrow, minOutputAmount: BigInt(c.min_output_amount) });
      expectNative(result.instruction, c.create);
    }
    const cancel = buildCancelLimitOrderInstruction(decodeLimitOrder(bytes(c.accounts.open.data_hex)), { network: c.network });
    expectNative(cancel, c.cancel);
    // The owner is the only signer and the fee payer of both compiled messages.
    for (const [ix, expected] of [[byPrice.instruction, c.create_message], [cancel, c.cancel_message]] as const) {
      const message = compileRouterMessage([ix], c.owner, new Uint8Array(32));
      expect(message.header.num_required_signatures).toBe(1);
      expect(base58.encode(message.account_keys[0]!)).toBe(c.owner);
      expect(hex.encode(SanitizedMessageUtil.serialize(message))).toBe(expected.message_hex);
    }
  });

  it("matches the IDL account order, privileges and discriminators", () => {
    const c = cases[0]!;
    const create = buildCreateLimitOrderInstruction({ ...createRequest(c), minOutputAmount: 1n });
    const cancel = buildCancelLimitOrderInstruction(decodeLimitOrder(bytes(c.accounts.open.data_hex)));
    const programs = NETWORKS.testnet.programs;
    const expected: Record<string, Record<string, string>> = {
      create_limit_order: {
        config: c.config, payer: c.owner, owner: c.owner, limit_order: c.order, escrow_token_account: c.escrow,
        base_mint: c.base_mint, quote_mint: c.quote_mint, owner_input_token_account: c.owner_input_ata,
        owner_output_token_account: c.owner_output_ata, apl_token_program: programs.tokenProgramId,
        system_program: programs.systemProgramId, associated_token_program: programs.associatedTokenProgramId,
      },
      cancel_limit_order: {
        payer: c.owner, owner: c.owner, limit_order: c.order, escrow_token_account: c.escrow,
        input_mint: c.quote_mint, owner_input_token_account: c.owner_input_ata, rent_refund: c.owner,
        apl_token_program: programs.tokenProgramId, system_program: programs.systemProgramId,
        associated_token_program: programs.associatedTokenProgramId,
      },
    };
    for (const [name, ix] of [["create_limit_order", create.instruction], ["cancel_limit_order", cancel]] as const) {
      const entry = idl.instructions.find((instruction) => instruction.name === name)!;
      expect([...ix.data.subarray(0, 1)]).toEqual(entry.discriminator);
      expect(metas(ix)).toEqual(entry.accounts.map((meta) => ({
        pubkey: expected[name]![meta.name], is_signer: meta.signer, is_writable: meta.writable,
      })));
    }
    const fields = (name: string) => idl.types.find((type) => type.name === name)!.type.fields!.map((field) => field.name);
    expect(fields("CreateLimitOrderParams")).toEqual(["order_id", "side", "input_amount", "min_output_amount", "fill_allowance_lamports"]);
    expect(fields("LimitOrder")).toEqual([
      "version", "status", "config", "owner", "order_id", "base_mint", "quote_mint", "side", "input_amount",
      "min_output_amount", "created_at", "rent_refund", "fill_allowance_lamports", "closed_at", "output_amount",
    ]);
    expect(idl.accounts[0]!.discriminator).toEqual([...new TextEncoder().encode("PROPORD1")]);
  });

  it("rejects invalid create requests before deriving accounts", () => {
    const c = cases[0]!;
    const request = { ...createRequest(c), minOutputAmount: 1n };
    expect(() => buildCreateLimitOrderInstruction({ ...request, market: { baseMint: c.base_mint, quoteMint: c.base_mint } }))
      .toThrow(sdkError("INVALID_INSTRUCTION"));
    expect(() => buildCreateLimitOrderInstruction({ ...request, owner: "not-base58!" })).toThrow(sdkError("INVALID_ADDRESS"));
    expect(() => buildCreateLimitOrderInstruction({ ...request, orderId: new Uint8Array(16) })).toThrow(sdkError("INVALID_INSTRUCTION"));
    expect(() => buildCreateLimitOrderInstruction({ ...request, minOutputAmount: 0n })).toThrow(sdkError("INVALID_INSTRUCTION"));
    expect(() => buildCreateLimitOrderInstruction({
      ...createRequest(c), limitPrice: "1e3", baseDecimals: 8, quoteDecimals: 6,
    })).toThrow(sdkError("INVALID_LIMIT_PRICE"));
  });

  it("cancels only open orders of the selected deployment", () => {
    const c = cases[2]!;
    const open = decodeLimitOrder(bytes(c.accounts.open.data_hex));
    for (const status of ["filled", "cancelled"] as const) {
      expect(() => buildCancelLimitOrderInstruction({ ...open, status }, { network: "mainnet" })).toThrow(sdkError("INVALID_INSTRUCTION"));
    }
    expect(() => buildCancelLimitOrderInstruction(open, { network: "testnet" })).toThrow(/another PropAMM config/);
    // A recorded third-party refund address is preserved, not replaced by the owner.
    const refund = base58.encode(new Uint8Array(32).fill(9));
    const cancel = buildCancelLimitOrderInstruction({ ...open, rentRefund: refund }, { network: "mainnet" });
    expect(base58.encode(cancel.accounts[6]!.pubkey)).toBe(refund);
  });

  it("generates random 32-byte order IDs", () => {
    const [a, b] = [generateLimitOrderId(), generateLimitOrderId()];
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(b);
  });
});

describe("loadLimitOrder", () => {
  const c = cases[2]!;
  const options = { network: c.network };
  const info = (data: Uint8Array, owner = c.program) => ({
    data, owner: base58.decode(owner), lamports: 1, utxo: "fixture:0", is_executable: false,
  });
  const source = (result: ReturnType<typeof info> | null) => ({ getAccounts: vi.fn(async () => [result]) });

  it("reads one account and validates its identity", async () => {
    const reader = source(info(bytes(c.accounts.filled.data_hex)));
    const order = await loadLimitOrder(reader, c.order, options);
    expect(order).toMatchObject({ status: "filled", owner: c.owner, outputAmount: BigInt(c.accounts.filled.output_amount) });
    expect(reader.getAccounts).toHaveBeenCalledExactlyOnceWith([c.order]);
  });

  it("treats missing and empty system accounts as not yet created", async () => {
    expect(await loadLimitOrder(source(null), c.order, options)).toBeNull();
    expect(await loadLimitOrder(source(info(new Uint8Array(), NETWORKS.mainnet.programs.systemProgramId)), c.order, options)).toBeNull();
  });

  it("rejects foreign owners, other addresses and other configs", async () => {
    const data = bytes(c.accounts.open.data_hex);
    await expect(loadLimitOrder(source(info(data, c.owner)), c.order, options)).rejects.toThrow(sdkError("INVALID_ACCOUNT"));
    await expect(loadLimitOrder(source(info(data)), c.escrow, options)).rejects.toThrow(/identity/);
    const testnet = bytes(cases[0]!.accounts.open.data_hex);
    await expect(loadLimitOrder(source(info(testnet)), cases[0]!.order, options)).rejects.toThrow(/identity/);
  });
});

describe("minimumOutputAtLimit", () => {
  const codes: Record<string, string> = {
    limit_order_zero_amounts: "INVALID_AMOUNT",
    limit_order_price_invalid: "INVALID_LIMIT_PRICE",
    limit_order_math_overflow: "MATH_OVERFLOW",
  };

  it.each(native.minimum_output_at_limit)("$side $input_amount at '$price' ($base_decimals/$quote_decimals)", (v) => {
    const run = () => minimumOutputAtLimit(v.side as LimitOrderSide, BigInt(v.input_amount), v.price, v.base_decimals, v.quote_decimals);
    if (v.output !== null) expect(run()).toBe(BigInt(v.output));
    else expect(run).toThrow(sdkError(codes[v.error!]!));
  });

  it("returns the smallest output that preserves the limit", () => {
    // Port of the native rational-inequality test, including ties and fractional prices.
    for (const side of ["buy", "sell"] as const) {
      for (let input = 1n; input <= 20n; input++) {
        for (const [raw, coefficient, scale] of [["3", 3n, 1n], ["0.125", 125n, 1000n], ["1.01", 101n, 100n]] as const) {
          for (let base = 0; base <= 3; base++) {
            for (let quote = 0; quote <= 3; quote++) {
              const result = minimumOutputAtLimit(side, input, raw, base, quote);
              const [numerator, denominator] = side === "buy"
                ? [input * 10n ** BigInt(base) * scale, coefficient * 10n ** BigInt(quote)]
                : [input * coefficient * 10n ** BigInt(quote), scale * 10n ** BigInt(base)];
              expect(result * denominator >= numerator).toBe(true);
              expect((result - 1n) * denominator < numerator).toBe(true);
            }
          }
        }
      }
    }
  });

  it("rejects non-u64 input and non-u32 decimals as request errors", () => {
    for (const run of [
      () => minimumOutputAtLimit("buy", 1n << 64n, "1", 0, 0),
      () => minimumOutputAtLimit("buy", 1 as never, "1", 0, 0),
      () => minimumOutputAtLimit("buy", 1n, "1", -1, 0),
      () => minimumOutputAtLimit("buy", 1n, "1", 0, 1.5),
      () => minimumOutputAtLimit("swap" as never, 1n, "1", 0, 0),
    ]) expect(run).toThrow(sdkError("INVALID_REQUEST"));
    // Native u32 decimals above 38 overflow u128 rather than being invalid.
    expect(() => minimumOutputAtLimit("sell", 1n, "1", 0, 0xffff_ffff)).toThrow(sdkError("MATH_OVERFLOW"));
    expect(() => minimumOutputAtLimit("buy", 1n, `0.${"0".repeat(38)}1`, 0, 0)).toThrow(sdkError("MATH_OVERFLOW"));
  });
});

describe("previewLimitOrder", () => {
  const market: LimitOrderMarketConfig = {
    baseMint: cases[0]!.base_mint, quoteMint: cases[0]!.quote_mint, baseSymbol: "aBTC", quoteSymbol: "aUSD",
    minBuyInput: 10_000_000n, minSellInput: 10_000n,
  };
  const request = {
    market, side: "buy", inputAmount: 100_000_000n, limitPrice: "100000", baseDecimals: 8, quoteDecimals: 6, fillFeeLamports: 1_000n,
  } as const;

  it("returns the minimum output and the trigger's default allowance", () => {
    expect(previewLimitOrder(request)).toEqual({ minOutputAmount: 100_000n, fillAllowanceLamports: 1_000n, errors: [] });
    expect(previewLimitOrder({ ...request, side: "sell", inputAmount: 100_000n }).minOutputAmount).toBe(100_000_000n);
  });

  it("reports unsupported markets, below-minimum input and invalid prices together", () => {
    expect(previewLimitOrder({ ...request, market: undefined }).errors.map((e) => e.code)).toEqual(["UNSUPPORTED_MARKET"]);
    const below = previewLimitOrder({ ...request, side: "sell", inputAmount: 9_999n });
    expect(below.errors).toEqual([{ code: "BELOW_MINIMUM_INPUT", message: expect.stringMatching(/10000 raw aBTC/) }]);
    expect(below.minOutputAmount).toBe(9_999_000n);
    const invalid = previewLimitOrder({ ...request, inputAmount: 0n, limitPrice: "1." });
    expect(invalid).toMatchObject({ minOutputAmount: null, fillAllowanceLamports: 1_000n });
    expect(invalid.errors.map((e) => e.code)).toEqual(["INVALID_AMOUNT", "BELOW_MINIMUM_INPUT"]);
    expect(previewLimitOrder({ ...request, limitPrice: "1.2.3" }).errors.map((e) => e.code)).toEqual(["INVALID_LIMIT_PRICE"]);
    expect(previewLimitOrder({ ...request, baseDecimals: 39 }).errors.map((e) => e.code)).toEqual(["MATH_OVERFLOW"]);
  });

  it("throws for programmer errors", () => {
    expect(() => previewLimitOrder({ ...request, fillFeeLamports: 1 as never })).toThrow(RouterSdkError);
    expect(() => previewLimitOrder({ ...request, baseDecimals: -1 })).toThrow(sdkError("INVALID_REQUEST"));
  });
});
