import { describe, expect, it, vi } from "vitest";
import type { AccountInfoResult } from "@arch-network/arch-sdk";
import {
  decodeAddress,
  deriveAssociatedTokenAddress,
  deriveProgramAddress,
  decodeMint,
  decodeTokenAccount,
  createAccountLoader,
  readAccounts,
  inputForOutput,
  U64_MAX,
} from "../src/utils.js";
import { TESTNET, TESTNET_MINTS } from "../src/config/networks.js";
import { RouterSdkError } from "../src/errors.js";
import type { RouterDataSource } from "../src/types.js";

// Expected keys and bumps come from arch-swap-router/tests/account_validation.rs.
const operator = "Gezw1yUcDjFhKQoJw6zq7nRJTc1MKhcUipNsUfrVpJKF";

describe("receive amount sizing", () => {
  it.each([1n, (1n << 53n) + 1n, U64_MAX])("finds exact u64 input %s with bounded work", (target) => {
    const estimate = vi.fn((input: bigint) => input);
    expect(inputForOutput(estimate, target)).toEqual({ amountIn: target, amountOut: target });
    expect(estimate.mock.calls.length).toBeLessThanOrEqual(65);
  });

  it("rejects a target that even the largest input cannot reach", () => {
    expect(() => inputForOutput((input) => input / 2n, U64_MAX))
      .toThrow(expect.objectContaining({ code: "OUTPUT_UNAVAILABLE" }));
  });

  it.each([new Error("unexpected"), new RouterSdkError("INVALID_ACCOUNT", "bad state")])(
    "propagates errors that are not amount boundaries: %s", (error) => {
      const estimate = vi.fn(() => { throw error; });
      expect(() => inputForOutput(estimate, 100n)).toThrow(error);
      expect(estimate).toHaveBeenCalledTimes(1);
    },
  );
});

describe("Arch SDK derivation compatibility", () => {
  it.each([
    [TESTNET_MINTS.primeBTC, "48iL9oYHb14NazPBFN3mHjemCSLj5Tgxf9a9N3taww12"],
    [TESTNET_MINTS.primeUSD, "6fitWMWz7VYdQbhquSGwM1JPR2yCYn5iupMWUDYCfC2a"],
  ])("matches the Rust ATA fixture for %s", (mint, expected) => {
    expect(deriveAssociatedTokenAddress(operator, mint, TESTNET)).toBe(expected);
  });

  it.each([
    ["vault", TESTNET_MINTS.primeBTC, "6H4kmh2TKpkXH5sVCMMEThVZyZSXrsvPEpipY8aFoDF7"],
    ["reserve", TESTNET_MINTS.primeBTC, "EPvrvCfoQ2LPYX1AUf8yxM28WWXbJJdNWCazBz1VyYdq"],
    ["escrow", TESTNET_MINTS.primeBTC, "Gy7gccftxTxCbyDDmEMU2Lzddyw7jbiq65LvEfEHCSjm"],
    ["vault", TESTNET_MINTS.primeUSD, "CBiMudmQp9i1ZSMRApZTBAaAzdbRnDsHTaoN2YnXqBxC"],
    ["reserve", TESTNET_MINTS.primeUSD, "AnKv8wEGcHxCqqGHTdv8AYf1t43JRhZNRGxNYi6oT2bp"],
    ["escrow", TESTNET_MINTS.primeUSD, "3gRMfpECtvVbih8SCZfgJkMjF6HuGnwa4Zooo2j8Vcx7"],
  ])("matches the Rust %s PDA for %s", (seed, mint, expected) => {
    expect(
      deriveProgramAddress(
        [new TextEncoder().encode(seed), decodeAddress(mint)],
        TESTNET.vaultProgramId,
      ),
    ).toEqual([expected, 255]);
  });
});

describe("address decoding", () => {
  it("preserves leading zero bytes", () => {
    expect(decodeAddress(TESTNET.systemProgramId)).toEqual(new Uint8Array(32));
  });

  it.each(["0OIl", "", "1".repeat(31), "1".repeat(33)])(
    "rejects invalid public key %j",
    (address) => {
      expect(() => decodeAddress(address)).toThrow(RouterSdkError);
      expect(() => decodeAddress(address)).toThrow(
        expect.objectContaining({ code: "INVALID_ADDRESS" }),
      );
    },
  );
});

describe("batched account reads", () => {
  const info: AccountInfoResult = {
    owner: decodeAddress(TESTNET.tokenProgramId), data: new Uint8Array(82),
    lamports: 1, utxo: "fixture:0", is_executable: false,
  };

  it("deduplicates in request order, keeps null entries, and reads again next call", async () => {
    const source = { getAccounts: vi.fn(async () => [info, null]) };
    const keys = [TESTNET_MINTS.aBTC, TESTNET_MINTS.aUSD, TESTNET_MINTS.aBTC];
    expect([...await readAccounts(source, keys)]).toEqual([[keys[0], info], [keys[1], null]]);
    await readAccounts(source, keys);
    expect(source.getAccounts.mock.calls).toEqual([[keys.slice(0, 2)], [keys.slice(0, 2)]]);
  });

  it.each([
    null, {}, [], [info, null], new Array(1), [undefined], [0],
    [{ ...info, data: [] }], [{ ...info, owner: [] }],
    [{ ...info, owner: new Uint8Array(31) }], [{ ...info, lamports: NaN }],
    [{ ...info, lamports: -1 }], [{ ...info, lamports: "1" }],
    [{ ...info, utxo: null }], [{ ...info, is_executable: 0 }],
  ].map((response) => ({ response })))("rejects malformed response %# rather than treating it as absence", async ({ response }) => {
    const source = { getAccounts: vi.fn(async () => response) } as unknown as RouterDataSource;
    await expect(readAccounts(source, [TESTNET_MINTS.aBTC])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("shares overlapping in-flight reads while batching only the new addresses", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const source = { getAccounts: vi.fn(async (keys: readonly string[]) => keys.map(() => info as AccountInfoResult | null)) };
    source.getAccounts.mockImplementationOnce(async () => { await gate; return [info, null]; });
    const load = createAccountLoader(source);
    const first = load([TESTNET_MINTS.aBTC, TESTNET_MINTS.aUSD, TESTNET_MINTS.aBTC]);
    const second = load([TESTNET_MINTS.aUSD, TESTNET_MINTS.primeBTC]);
    expect(source.getAccounts.mock.calls).toEqual([
      [[TESTNET_MINTS.aBTC, TESTNET_MINTS.aUSD]], [[TESTNET_MINTS.primeBTC]],
    ]);
    release();
    expect([...await first]).toEqual([[TESTNET_MINTS.aBTC, info], [TESTNET_MINTS.aUSD, null]]);
    expect([...await second]).toEqual([[TESTNET_MINTS.aUSD, null], [TESTNET_MINTS.primeBTC, info]]);
    expect([...await load([TESTNET_MINTS.primeBTC, TESTNET_MINTS.aUSD])])
      .toEqual([[TESTNET_MINTS.primeBTC, info], [TESTNET_MINTS.aUSD, null]]);
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
  });

  it("caches confirmed absence only within the request and skips empty batches", async () => {
    const source = { getAccounts: vi.fn(async (): Promise<readonly (AccountInfoResult | null)[]> => [null]) };
    const load = createAccountLoader(source);
    expect([...await load([])]).toEqual([]);
    expect(source.getAccounts).not.toHaveBeenCalled();
    expect((await load([TESTNET_MINTS.aBTC])).get(TESTNET_MINTS.aBTC)).toBeNull();
    source.getAccounts.mockResolvedValue([info]);
    expect((await load([TESTNET_MINTS.aBTC])).get(TESTNET_MINTS.aBTC)).toBeNull();
    expect((await createAccountLoader(source)([TESTNET_MINTS.aBTC])).get(TESTNET_MINTS.aBTC)).toBe(info);
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
  });

  it("retains valid accounts when another account in the same batch is malformed", async () => {
    const source = { getAccounts: vi.fn(async () => [info, { ...info, data: [] as unknown as Uint8Array }]) };
    const load = createAccountLoader(source);
    const keys = [TESTNET_MINTS.aBTC, TESTNET_MINTS.aUSD];
    const error: unknown = await load(keys).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE" });
    expect((await load([keys[0]!])).get(keys[0]!)).toBe(info);
    await expect(load([keys[1]!])).rejects.toBe(error);
    expect(source.getAccounts).toHaveBeenCalledExactlyOnceWith(keys);
  });

  it.each(["transport", "malformed"])("shares a %s failure without retrying or caching it in the next request", async (failure) => {
    const error = new Error("RPC unavailable");
    const source = { getAccounts: vi.fn(async (): Promise<readonly (AccountInfoResult | null)[]> => {
      if (failure === "transport") throw error;
      return []; // Invalid response length must reject, never become confirmed absence.
    }) };
    const load = createAccountLoader(source);
    const results = await Promise.allSettled([load([TESTNET_MINTS.aBTC]), load([TESTNET_MINTS.aBTC])]);
    const reason = results[0].status === "rejected" ? results[0].reason : undefined;
    if (failure === "transport") expect(reason).toBe(error);
    else expect(reason).toMatchObject({ code: "INVALID_RESPONSE" });
    expect(results[1]).toEqual({ status: "rejected", reason });
    source.getAccounts.mockResolvedValue([info]);
    await expect(load([TESTNET_MINTS.aBTC])).rejects.toBe(reason);
    expect(source.getAccounts).toHaveBeenCalledOnce();
    expect((await createAccountLoader(source)([TESTNET_MINTS.aBTC])).get(TESTNET_MINTS.aBTC)).toBe(info);
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
  });
});

describe("minimal APL readers", () => {
  function mint() { const data = new Uint8Array(82); data[45] = 1; return data; }
  function token() { const data = new Uint8Array(165); data[108] = 1; return data; }

  it("reads u64 supply, decimals and balances from offset views", () => {
    const bytes = new Uint8Array(90);
    bytes.set(mint(), 4);
    const view = bytes.subarray(4, 86);
    new DataView(view.buffer, view.byteOffset).setBigUint64(36, 0xfedcba9876543210n, true);
    view[44] = 9;
    expect(decodeMint(view)).toEqual({ supply: 0xfedcba9876543210n, decimals: 9 });
    const balance = token();
    balance.set(decodeAddress(TESTNET_MINTS.aBTC));
    balance.set(decodeAddress(operator), 32);
    new DataView(balance.buffer).setBigUint64(64, 0xfedcba9876543210n, true);
    balance[108] = 2; // Frozen is still decodable; execution readiness belongs elsewhere.
    expect(decodeTokenAccount(balance)).toEqual({ mint: TESTNET_MINTS.aBTC, owner: operator, amount: 0xfedcba9876543210n });
  });

  it.each([0, 82, 83, 164, 165, 166])("enforces APL account lengths (%s)", (length) => {
    const bytes = new Uint8Array(length);
    if (length !== 82) expect(() => decodeMint(bytes)).toThrow(RouterSdkError);
    if (length !== 165) expect(() => decodeTokenAccount(bytes)).toThrow(RouterSdkError);
  });

  it.each([0, 46])("validates every mint COption tag at %s", (offset) => {
    const data = mint(); data[offset + 1] = 1;
    expect(() => decodeMint(data)).toThrow(RouterSdkError);
  });

  it.each([72, 109, 129])("validates every token COption tag at %s", (offset) => {
    const data = token(); data[offset] = 2;
    expect(() => decodeTokenAccount(data)).toThrow(RouterSdkError);
  });

  it.each([0, 2, 255])("rejects invalid mint initialization %s", (flag) => {
    const data = mint(); data[45] = flag;
    expect(() => decodeMint(data)).toThrow(RouterSdkError);
  });

  it.each([0, 3, 255])("rejects invalid token initialization %s", (flag) => {
    const data = token(); data[108] = flag;
    expect(() => decodeTokenAccount(data)).toThrow(RouterSdkError);
  });
});
