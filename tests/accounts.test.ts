import type { AccountInfoResult } from "@arch-network/arch-sdk";
import { describe, expect, it, vi } from "vitest";
import { decodeAddress, readAccounts, type RouterDataSource } from "../src/accounts.js";
import { TESTNET_MINTS } from "../src/config/mints.js";
import { TOKEN_PROGRAMS } from "../src/config/shared.js";
import { RouterSdkError } from "../src/errors.js";

describe("address decoding", () => {
  it("preserves leading zero bytes", () => {
    expect(decodeAddress(TOKEN_PROGRAMS.systemProgramId)).toEqual(new Uint8Array(32));
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
    owner: decodeAddress(TOKEN_PROGRAMS.tokenProgramId), data: new Uint8Array(82),
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

  it("propagates transport failure and reads fresh data on the next call", async () => {
    const error = new Error("RPC unavailable");
    const source = { getAccounts: vi.fn(async (): Promise<readonly (AccountInfoResult | null)[]> => [info]) };
    source.getAccounts.mockRejectedValueOnce(error);
    await expect(readAccounts(source, [TESTNET_MINTS.aBTC])).rejects.toBe(error);
    expect((await readAccounts(source, [TESTNET_MINTS.aBTC])).get(TESTNET_MINTS.aBTC)).toBe(info);
    expect(source.getAccounts).toHaveBeenCalledTimes(2);
  });
});
