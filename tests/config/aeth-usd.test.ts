import { TransactionUtil } from "@arch-network/arch-sdk";
import { base58, hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAINNET_AETH_USD as market } from "../../src/index.js";
import { decodeAddress, deriveAddress, deriveProgramAddress } from "../../src/utils.js";
import fixtures from "../fixtures/aeth-usd/transactions.json" with { type: "json" };

import { nativeTransaction } from "../fixtures/aeth-usd/transactions.js";

const ata = (mint: string) => deriveProgramAddress([
  decodeAddress(fixtures.user), decodeAddress(market.tokenProgramId), decodeAddress(mint),
], market.associatedTokenProgramId)[0];

const u64 = (data: Uint8Array, offset: number) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(fixtures.now_ms); });
afterEach(() => { vi.restoreAllMocks(); });

describe("fixed mainnet aETH/aUSD market", () => {
  it("matches the canonical config and vault addresses", () => {
    expect(Object.isFrozen(market)).toBe(true);
    expect(market.baseDecimals).toBe(6);
    expect(market.quoteDecimals).toBe(6);
    for (const value of Object.values(market)) if (typeof value === "string") expect(decodeAddress(value)).toHaveLength(32);
    expect(deriveAddress(market.programId, "config_v2", decodeAddress(market.quoteSigner))).toBe(market.config);
    expect(deriveAddress(market.programId, "vault", decodeAddress(market.config), decodeAddress(market.baseMint))).toBe(market.baseVault);
    expect(deriveAddress(market.programId, "vault", decodeAddress(market.config), decodeAddress(market.quoteMint))).toBe(market.quoteVault);
  });

  it.each(fixtures.cases)("replays the unsigned Rust $side fixture, with the original message and signer roles", (fixture) => {
    const buy = fixture.side === "buy";
    const transaction = nativeTransaction(fixture.transaction_hex);
    const { message } = transaction;
    const keys = message.account_keys.map(base58.encode);
    expect(transaction.version).toBe(0);
    expect(transaction.signatures).toEqual([]);
    expect(message.header.num_required_signatures).toBe(2);
    expect(keys.slice(0, 2)).toEqual([fixtures.user, buy ? market.treasuryAuthority : market.quoteSigner]);
    expect(fixture.server_signer).toBe(keys[1]);
    expect(fixture.input_mint).toBe(buy ? market.quoteMint : market.baseMint);
    expect(fixture.output_mint).toBe(buy ? market.baseMint : market.quoteMint);
    expect(fixture.expires_at_ms - Date.now()).toBe(30_000);
    expect(message.recent_blockhash).toEqual(new Uint8Array(32).fill(0x55));
    expect(hex.encode(TransactionUtil.serialize(transaction))).toBe(fixture.transaction_hex);

    const measured = { ...transaction, signatures: [new Uint8Array(64), new Uint8Array(64)] };
    expect(TransactionUtil.serializedSize(measured)).toBe(fixture.signed_size);
    expect(fixture.signed_size).toBeLessThanOrEqual(1232);
    const programs = message.instructions.map(ix => keys[ix.program_id_index]);
    expect(programs).toEqual(buy ? [market.tokenProgramId, market.bridgeProgramId] : [market.programId]);

    if (buy) {
      const [payment, mint] = message.instructions;
      expect(payment!.data).toHaveLength(9);
      expect(payment!.data[0]).toBe(3);
      expect(u64(payment!.data, 1)).toBe(BigInt(fixture.amount_in));
      expect(payment!.accounts.map(index => keys[index])).toEqual([ata(market.quoteMint), market.quoteVault, fixtures.user]);
      expect(mint!.data).toHaveLength(73);
      expect(mint!.data[0]).toBe(21);
      expect(mint!.data.slice(1, 33)).toEqual(new Uint8Array(32).fill(0x44));
      expect(u64(mint!.data, 33)).toBe(BigInt(fixture.estimated_amount_out));
      expect(mint!.data.slice(41)).toEqual(decodeAddress(fixtures.user));
      expect(mint!.accounts.map(index => keys[index])).toEqual([
        market.treasuryAuthority,
        deriveAddress(market.bridgeProgramId, "config"),
        deriveAddress(market.bridgeProgramId, "asset", decodeAddress(market.baseMint)),
        deriveAddress(market.bridgeProgramId, "treasury_mint", mint!.data.slice(1, 33)),
        market.baseMint,
        deriveAddress(market.bridgeProgramId, "mint-authority", decodeAddress(market.baseMint)),
        fixtures.user, ata(market.baseMint), market.tokenProgramId,
        market.associatedTokenProgramId, market.systemProgramId,
      ]);
      expect(fixture.min_amount_out).toBe(fixture.estimated_amount_out);
    } else {
      const trade = message.instructions[0]!;
      expect(trade.data).toHaveLength(50);
      expect(trade.data.slice(0, 2)).toEqual(Uint8Array.of(2, 1));
      expect(u64(trade.data, 2)).toBe(BigInt(fixture.amount_in));
      expect(u64(trade.data, 10)).toBe(BigInt(fixture.estimated_amount_out));
      expect(u64(trade.data, 18)).toBe(BigInt(fixture.expires_at_ms));
      expect(u64(trade.data, 26)).toBe(BigInt(fixtures.now_ms));
      expect(u64(trade.data, 34)).toBe(BigInt(fixture.amount_in));
      expect(u64(trade.data, 42)).toBe(BigInt(fixture.min_amount_out));
      expect(trade.accounts.map(index => keys[index])).toEqual([
        market.config, market.quoteSigner, fixtures.user,
        deriveAddress(market.programId, "user_nonce", decodeAddress(market.config), decodeAddress(fixtures.user)),
        market.baseVault, market.quoteVault, ata(market.baseMint), ata(market.quoteMint),
        market.baseMint, market.quoteMint, market.tokenProgramId,
        market.systemProgramId, market.associatedTokenProgramId,
      ]);
    }
  });
});
