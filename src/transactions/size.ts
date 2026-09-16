import type { Instruction } from "@arch-network/arch-sdk";
import { NotImplementedError } from "../errors/index.js";
import type { Address } from "../types.js";

export function measureSignedSize(
  _instructions: readonly Instruction[],
  _user: Address,
): number {
  throw new NotImplementedError("measureSignedSize");
}
