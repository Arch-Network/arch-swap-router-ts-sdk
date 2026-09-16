import { NotImplementedError } from "../errors/index.js";
import type { Address, RouterDeployment } from "../types.js";

export function deriveAssociatedTokenAddress(
  _owner: Address,
  _mint: Address,
  _deployment: RouterDeployment,
): Address {
  throw new NotImplementedError("deriveAssociatedTokenAddress");
}
