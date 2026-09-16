import type { AccountInfoResult } from "@arch-network/arch-sdk";
import { NotImplementedError } from "../errors/index.js";
import type { Address, RouterDataSource } from "../types.js";

export async function readAccounts(
  _source: RouterDataSource,
  _addresses: readonly Address[],
): Promise<readonly (AccountInfoResult | null)[]> {
  throw new NotImplementedError("readAccounts");
}
