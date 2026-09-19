import { base58 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountInfoResult } from "@arch-network/arch-sdk";
import { createRouterClient } from "../src/client.js";
import { TESTNET, TESTNET_VENUES } from "../src/config/networks.js";
import { assetsForShares, decodeVault, estimateVault, prepareVaultQuote, sharesForAssets } from "../src/vault.js";
import { applyFee, decodeAddress, deriveAddress, deriveAssociatedTokenAddress, U64_MAX } from "../src/utils.js";
import { buildInput, expectedRouterInstruction, namedFixture } from "./transactions/fixtures.js";
import contract from "./fixtures/vault/contract.json" with { type: "json" };

const rawVault = () => Uint8Array.from(contract.vault.match(/../g)!, (byte) => parseInt(byte, 16));
const now = 1_800_000_000n;
const setU64 = (bytes: Uint8Array, offset: number, value: bigint) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(offset, value, true);
const key = (byte: number) => base58.encode(new Uint8Array(32).fill(byte));

function state() {
  return {
    ...decodeVault(rawVault()), paused: false, offChainBalance: 0n,
    offChainReportedAt: now, maxTotalAssets: U64_MAX, maxNavStalenessSecs: 60,
    queueHead: 42n, queueTail: 42n, mintFee: { kind: "fixed", amount: 0n } as const,
  };
}

function setup(usd = false, redeem = false) {
  const venue = usd ? TESTNET_VENUES.usdVault : TESTNET_VENUES.btcVault;
  const fixture = namedFixture(`direct-${redeem ? "redeem" : "mint"}-${usd ? "usd" : "btc"}`);
  const addresses = buildInput(namedFixture(`direct-redeem-${usd ? "usd" : "btc"}`)).steps[0]!;
  if (addresses.kind !== "vaultRedeem") throw new Error("Expected redeem fixture");
  const vault = rawVault();
  setU64(vault, 8, 0n);
  setU64(vault, 16, now);
  setU64(vault, 24, U64_MAX);
  setU64(vault, 40, 42n);
  setU64(vault, 48, 42n);
  setU64(vault, 64, 0n);
  vault[393] = 0;
  for (const offset of [201, 233]) vault.set(new Uint8Array(32).fill(usd ? 42 : 41), offset);
  for (const [offset, address] of [
    [265, venue.assetMint], [297, venue.shareMint], [329, addresses.reserve], [361, addresses.escrow],
  ] as const) vault.set(decodeAddress(address), offset);
  vault.set([255, 255, 255], 394);
  function mint(supply: bigint, decimals: number) {
    const data = new Uint8Array(82);
    data[0] = 1;
    data.set(decodeAddress(venue.address), 4);
    setU64(data, 36, supply);
    data[44] = decimals;
    data[45] = 1;
    return data;
  }
  const reserve = new Uint8Array(165);
  reserve.set(decodeAddress(venue.assetMint));
  reserve.set(decodeAddress(venue.address), 32);
  setU64(reserve, 64, 10_000n);
  reserve[108] = 1;
  const info = (data: Uint8Array, owner: string = TESTNET.tokenProgramId): AccountInfoResult => ({
    data, owner: decodeAddress(owner), lamports: 1, utxo: "fixture:0", is_executable: false,
  });
  const accounts = [info(vault, TESTNET.vaultProgramId), info(mint(100_000n, 8)), info(mint(10_000n, 11)), info(reserve)];
  const source = { getAccounts: vi.fn(async (_keys: readonly string[]): Promise<readonly (AccountInfoResult | null)[]> => accounts) };
  const request = {
    inputMint: redeem ? venue.shareMint : venue.assetMint,
    outputMint: redeem ? venue.assetMint : venue.shareMint,
    amountIn: 1000n, slippageBps: 50, deadlineMs: fixture.deadlineMs, user: fixture.user,
  };
  return { vault, reserve, accounts, source, request, fixture, venue, addresses, client: createRouterClient({ source }) };
}

describe("vault contract", () => {
  it("resolves and validates accounts with selected programs and venue identities", () => {
    const { accounts, vault, reserve } = setup(false, true);
    const programs = { ...TESTNET, vaultProgramId: key(61), tokenProgramId: key(62), associatedTokenProgramId: key(63) };
    const venue = { address: key(64), assetMint: key(65), shareMint: key(66) };
    const reserveAddress = deriveAddress(programs.vaultProgramId, "reserve", decodeAddress(venue.shareMint));
    const escrow = deriveAddress(programs.vaultProgramId, "escrow", decodeAddress(venue.shareMint));
    for (const [offset, address] of [[265, venue.assetMint], [297, venue.shareMint], [329, reserveAddress], [361, escrow]] as const) {
      vault.set(decodeAddress(address), offset);
    }
    reserve.set(decodeAddress(venue.assetMint)); reserve.set(decodeAddress(venue.address), 32);
    accounts.forEach((account, i) => { account.owner = decodeAddress(i === 0 ? programs.vaultProgramId : programs.tokenProgramId); });
    const map = new Map([venue.address, venue.assetMint, venue.shareMint, reserveAddress].map((address, i) => [address, accounts[i]!]));
    const quote = prepareVaultQuote(map, venue, "vaultRedeem", now, programs);
    const tail = new Uint8Array(8); setU64(tail, 0, 42n);
    expect(quote.resolved).toEqual({
      kind: "vaultRedeem", outputMint: venue.assetMint, vault: venue.address, reserve: reserveAddress, escrow,
      redemptionEntry: deriveAddress(programs.vaultProgramId, "redeem", decodeAddress(venue.address), tail),
      protocolFeeShares: deriveAssociatedTokenAddress(key(41), venue.shareMint, programs),
      managerFeeShares: deriveAssociatedTokenAddress(key(41), venue.shareMint, programs),
      eventAuthority: deriveAddress(programs.vaultProgramId, "__event_authority"),
    });
    expect(quote.estimate(1000n)).toBe(assetsForShares(1000n, 10_000n, 10_000n) - applyFee(decodeVault(vault).redeemFee, assetsForShares(1000n, 10_000n, 10_000n)));
    accounts[0]!.owner = decodeAddress(TESTNET.vaultProgramId);
    expect(() => prepareVaultQuote(map, venue, "vaultRedeem", now, programs))
      .toThrow(expect.objectContaining({ code: "INVALID_ACCOUNT" }));
  });

  it("decodes the untouched Rust account fixture, including an offset byte view", () => {
    const bytes = new Uint8Array(620);
    bytes.set(rawVault(), 3);
    expect(decodeVault(bytes.subarray(3, 619))).toEqual({
      offChainBalance: 0x1122334455667788n, offChainReportedAt: 1_785_887_273n,
      maxTotalAssets: 1_000_000_000_000_000n, queueHead: 4n, queueTail: 11n,
      mintFee: { kind: "fixed", amount: 9n }, redeemFee: { kind: "percentage", bps: 30 },
      maxNavStalenessSecs: 86400, feeRecipient: key(4), protocolFeeRecipient: key(9),
      assetMint: key(5), shareMint: key(6), reserve: key(7), escrow: key(8), paused: true,
    });
  });

  it.each(contract.math)("matches native $fn: $out", (vector) => {
    const result = vector.fn === "fee_percentage"
      ? applyFee({ kind: "percentage", bps: vector.bps! }, BigInt(vector.base!))
      : (vector.fn === "shares_for_assets" ? sharesForAssets : assetsForShares)(
        BigInt(vector.in!), BigInt(vector.total_assets!), BigInt(vector.share_supply!),
      );
    expect(result).toBe(BigInt(vector.out));
  });

  it.each([
    (data: Uint8Array) => data.subarray(0, 615),
    (data: Uint8Array) => new Uint8Array([...data, 0]),
    (data: Uint8Array) => { data[0] = 0; return data; },
    (data: Uint8Array) => { data[56] = 2; return data; },
    (data: Uint8Array) => { setU64(data, 80, 65536n); return data; },
  ])("rejects malformed vault data %#", (mutate) => {
    expect(() => decodeVault(mutate(rawVault()))).toThrow(expect.objectContaining({ code: "INVALID_ACCOUNT" }));
  });

  it("treats any nonzero pause byte as paused", () => {
    const data = rawVault(); data[393] = 255;
    expect(decodeVault(data).paused).toBe(true);
  });

  it("matches native Mint pre-flow pricing and full-deposit cap tests", () => {
    const vault = { ...state(), mintFee: { kind: "fixed", amount: 100n } as const, maxTotalAssets: 11_000n };
    expect(estimateVault(state(), 10_000n, 10_000n, "vaultMint", 1000n, now)).toBe(1099n);
    expect(estimateVault(vault, 10_000n, 10_000n, "vaultMint", 1000n, now)).toBe(989n);
    expect(() => estimateVault({ ...vault, maxTotalAssets: 10_999n }, 10_000n, 10_000n, "vaultMint", 1000n, now))
      .toThrow(expect.objectContaining({ code: "DEPOSIT_CAP" }));
  });

  it("matches native full Redeem fee settlement (TC-FEE-17)", () => {
    expect(estimateVault({ ...state(), redeemFee: { kind: "percentage", bps: 100 } },
      20_000n, 10_000n, "vaultRedeem", 5000n, now)).toBe(9000n);
  });

  it.each([now - 60n, now, now + 60n])("accepts NAV at the boundary or in the future: %s", (reported) => {
    expect(estimateVault({ ...state(), offChainReportedAt: reported }, 10_000n, 10_000n, "vaultMint", 1000n, now)).toBe(1099n);
  });

  it.each([
    ["VAULT_PAUSED", { paused: true }, 10_000n, 10_000n, 1000n, "vaultMint"],
    ["VAULT_PAUSED", { paused: true }, 10_000n, 10_000n, 1000n, "vaultRedeem"],
    ["STALE_NAV", { offChainReportedAt: now - 61n }, 10_000n, 10_000n, 1000n, "vaultMint"],
    ["MATH_OVERFLOW", { offChainReportedAt: -(1n << 63n) }, 10_000n, 10_000n, 1000n, "vaultMint"],
    ["DEPOSIT_CAP", { maxTotalAssets: 0n }, 0n, 0n, 1n, "vaultMint"],
    ["ZERO_OUTPUT", { mintFee: { kind: "fixed", amount: 1000n } }, 10_000n, 10_000n, 1000n, "vaultMint"],
    ["ZERO_OUTPUT", {}, 10_000_000n, 0n, 100n, "vaultMint"],
    ["ZERO_OUTPUT", {}, 1n, 1000n, 1n, "vaultRedeem"],
    ["ZERO_OUTPUT", { redeemFee: { kind: "percentage", bps: 10_000 } }, 10_000n, 10_000n, 1000n, "vaultRedeem"],
    ["REDEEM_UNAVAILABLE", { queueTail: 43n }, 10_000n, 10_000n, 1000n, "vaultRedeem"],
    // Net claim 9000 fits, gross claim 9091 does not.
    ["REDEEM_UNAVAILABLE", { offChainBalance: 11_000n, redeemFee: { kind: "percentage", bps: 100 } }, 9000n, 10_000n, 5000n, "vaultRedeem"],
    ["INVALID_ACCOUNT", { redeemFee: { kind: "fixed", amount: 0n } }, 10_000n, 10_000n, 1000n, "vaultRedeem"],
    ["MATH_OVERFLOW", { offChainBalance: 1n }, U64_MAX, 10_000n, 1000n, "vaultMint"],
    ["MATH_OVERFLOW", {}, 10_000n, U64_MAX, 1n, "vaultMint"],
    ["MATH_OVERFLOW", { queueHead: U64_MAX, queueTail: U64_MAX }, 10_000n, 10_000n, 1000n, "vaultRedeem"],
  ] as const)("rejects %s case %#", (code, overrides, reserve, supply, amount, operation) => {
    expect(() => estimateVault({ ...state(), ...overrides }, reserve, supply, operation, amount, now))
      .toThrow(expect.objectContaining({ code }));
  });

  it("checks u128 intermediates even when the divided result would fit u64", () => {
    expect(() => sharesForAssets(U64_MAX - 1000n, U64_MAX, U64_MAX)).not.toThrow();
    expect(() => sharesForAssets(U64_MAX, U64_MAX, U64_MAX))
      .toThrow(expect.objectContaining({ code: "MATH_OVERFLOW" }));
  });

  it("allows immediate redemption with stale NAV, matching native fill", () => {
    expect(estimateVault({ ...state(), offChainReportedAt: 0n }, 10_000n, 10_000n, "vaultRedeem", 1000n, now)).toBe(906n);
  });
});

describe("direct vault quoteExactIn", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Number(now) * 1000 + 999); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "quotes and builds in one four-account batch (USD=%s, Redeem=%s)", async (usd, redeem) => {
      const { client, request, source, fixture, venue, addresses } = setup(usd, redeem);
      const quote = await client.quoteExactIn(request);
      expect(quote).toEqual({
        inputMint: request.inputMint, outputMint: request.outputMint, amountIn: 1000n,
        estimatedAmountOut: redeem ? 906n : 1099n, minAmountOut: redeem ? 901n : 1093n,
        hops: [{
          kind: redeem ? "vaultRedeem" : "vaultMint", inputMint: request.inputMint, outputMint: request.outputMint,
          amountIn: 1000n, estimatedAmountOut: redeem ? 906n : 1099n,
        }],
        deadlineMs: fixture.deadlineMs, instructions: [expect.any(Object)],
      });
      const instruction = quote.instructions[0]!;
      const expected = expectedRouterInstruction(fixture);
      expect(instruction.accounts).toEqual(expected.accounts);
      expect(instruction.program_id).toEqual(expected.program_id);
      const data = new Uint8Array(expected.data);
      setU64(data, 1, 1000n); setU64(data, 9, redeem ? 901n : 1093n);
      expect(instruction.data).toEqual(data);
      expect(source.getAccounts.mock.calls).toEqual([[ [venue.address, venue.assetMint, venue.shareMint, addresses.reserve] ]]);
      expect(Date.now).toHaveBeenCalledTimes(1);
    },
  );

  it("reads fresh state and derives changed fee destinations and queue tails on every call", async () => {
    const { client, request, source, vault } = setup(false, true);
    const first = await client.quoteExactIn(request);
    setU64(vault, 8, 1000n); setU64(vault, 40, 43n); setU64(vault, 48, 43n);
    vault.set(new Uint8Array(32).fill(43), 233);
    const second = await client.quoteExactIn(request);
    expect(first.estimatedAmountOut).toBe(906n);
    expect(second.estimatedAmountOut).toBe(997n);
    expect(second.instructions[0]!.accounts[10]).not.toEqual(first.instructions[0]!.accounts[10]);
    expect(base58.encode(second.instructions[0]!.accounts[11]!.pubkey))
      .toBe(deriveAssociatedTokenAddress(key(43), request.inputMint, TESTNET));
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
  });

  it("uses reported share supply without hypothetical management accrual or decimal rescaling", async () => {
    const { client, request, accounts, vault } = setup();
    const first = await client.quoteExactIn(request);
    setU64(vault, 32, 0n); // Accrued timestamp years in the past, nonzero stored rate.
    accounts[1]!.data[44] = 6; accounts[2]!.data[44] = 12;
    expect((await client.quoteExactIn(request)).estimatedAmountOut).toBe(first.estimatedAmountOut);
  });

  it("captures NAV evaluation time once, before the asynchronous read", async () => {
    const { client, request, source, accounts } = setup();
    source.getAccounts.mockImplementationOnce(async () => {
      vi.mocked(Date.now).mockReturnValue(Number(now + 1_000_000n) * 1000);
      return accounts;
    });
    expect((await client.quoteExactIn(request)).estimatedAmountOut).toBe(1099n);
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("preserves deadline %s without expiry policy", async (deadlineMs) => {
    const { client, request } = setup();
    const quote = await client.quoteExactIn({ ...request, deadlineMs, slippageBps: 0 });
    expect(quote.deadlineMs).toBe(deadlineMs);
    expect(quote.minAmountOut).toBe(1099n);
    const data = Uint8Array.from(quote.instructions[0]!.data);
    expect(new DataView(data.buffer).getBigUint64(17, true)).toBe(BigInt(deadlineMs));
  });

  it("rejects slippage that leaves no positive minimum", async () => {
    const { client, request } = setup();
    await expect(client.quoteExactIn({ ...request, slippageBps: 9999 }))
      .rejects.toMatchObject({ code: "ZERO_OUTPUT" });
    await expect(client.quoteForOutput({ ...request, amountOut: 1099n, slippageBps: 9999 }))
      .rejects.toMatchObject({ code: "ZERO_OUTPUT" });
  });

  it("finds a receive target at the deposit cap despite fee dust and larger failing probes", async () => {
    const { client, request, source, vault } = setup();
    setU64(vault, 64, 100n); setU64(vault, 24, 11_000n);
    const quote = await client.quoteForOutput({ ...request, amountOut: 989n });
    expect(quote).toMatchObject({ amountIn: 1000n, estimatedAmountOut: 989n, minAmountOut: 984n });
    expect(source.getAccounts).toHaveBeenCalledTimes(1);
    await expect(client.quoteForOutput({ ...request, amountOut: 990n })).rejects.toMatchObject({ code: "DEPOSIT_CAP" });
  });

  it("does not exceed redeemable supply to reach a receive target", async () => {
    const { client, request, source } = setup(false, true);
    const quote = await client.quoteForOutput({ ...request, amountOut: 9063n });
    expect(quote).toMatchObject({ amountIn: 10000n, estimatedAmountOut: 9063n });
    expect(source.getAccounts).toHaveBeenCalledTimes(1);
    await expect(client.quoteForOutput({ ...request, amountOut: 9064n })).rejects.toMatchObject({ code: "MATH_OVERFLOW" });
  });

  it("does not exceed gross reserve coverage to reach a receive target", async () => {
    const { client, request, vault } = setup(false, true);
    setU64(vault, 8, 11_000n);
    await expect(client.quoteForOutput({ ...request, amountOut: 10_000n })).rejects.toMatchObject({ code: "REDEEM_UNAVAILABLE" });
  });

  it.each(["VAULT_PAUSED", "STALE_NAV", "REDEEM_UNAVAILABLE", "ZERO_OUTPUT"])(
    "preserves vault failure during receive sizing: %s", async (code) => {
      const { client, request, vault } = setup(false, code === "REDEEM_UNAVAILABLE");
      if (code === "VAULT_PAUSED") vault[393] = 1;
      if (code === "STALE_NAV") setU64(vault, 16, 0n);
      if (code === "REDEEM_UNAVAILABLE") setU64(vault, 48, 43n);
      if (code === "ZERO_OUTPUT") { vault[56] = 1; setU64(vault, 64, 10_000n); }
      await expect(client.quoteForOutput({ ...request, amountOut: 1000n })).rejects.toMatchObject({ code });
    },
  );

  it.each([0, 1, 2, 3])("rejects missing calculation account %s", async (index) => {
    const { client, request, source, accounts } = setup();
    source.getAccounts.mockResolvedValueOnce(accounts.map((info, i) => i === index ? null : info));
    await expect(client.quoteExactIn(request)).rejects.toMatchObject({ code: "MISSING_ACCOUNT" });
    expect(source.getAccounts).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2, 3])("rejects wrong owner for calculation account %s", async (index) => {
    const { client, request, accounts } = setup();
    accounts[index]!.owner = decodeAddress(TESTNET.systemProgramId);
    await expect(client.quoteExactIn(request)).rejects.toMatchObject({ code: "INVALID_ACCOUNT" });
  });

  it.each([265, 297, 329, 361, -1, -2])("rejects incorrect vault/reserve relationship %s", async (offset) => {
    const { client, request, vault, reserve } = setup();
    (offset >= 0 ? vault : reserve).set(new Uint8Array(32), offset >= 0 ? offset : offset === -1 ? 0 : 32);
    await expect(client.quoteExactIn(request)).rejects.toMatchObject({ code: "INVALID_ACCOUNT" });
  });

  it("propagates transport failures and retries with fresh reads on the next call", async () => {
    const { client, request, source } = setup();
    const error = new Error("Provider unavailable");
    source.getAccounts.mockRejectedValueOnce(error);
    await expect(client.quoteExactIn(request)).rejects.toBe(error);
    source.getAccounts.mockRejectedValueOnce(error);
    await expect(client.quoteForOutput({ ...request, amountOut: 1000n })).rejects.toBe(error);
    expect((await client.quoteExactIn(request)).estimatedAmountOut).toBe(1099n);
    expect(source.getAccounts).toHaveBeenCalledTimes(3);
  });
});
