import { bytesToHex, decodeProgramError, type ProgramErrorSource } from "@arch-network/arch-sdk";
import { describe, expect, it } from "vitest";
import { MAINNET, ROUTER_ERRORS, routerProgramErrorTable } from "../src/index.js";
import { decodeAddress } from "../src/utils.js";
import idl from "./fixtures/idl/arch_swap_router.idl.json" with { type: "json" };

const router = decodeAddress(MAINNET.routerProgramId);
const failure = (logs: readonly string[]): ProgramErrorSource => ({
  runtime_transaction: { message: { account_keys: [router], instructions: [{ program_id_index: 0 }] } },
  status: { type: "failed", message: "Error processing Instruction 0, error: custom program error: 0xb" },
  logs,
});

describe("router program errors", () => {
  it("is the committed IDL's error list", () => {
    expect(ROUTER_ERRORS).toEqual(idl.errors);
  });

  it("decodes the router's own code only when no inner program logged", () => {
    const tables = new Map([[bytesToHex(router), routerProgramErrorTable()]]);
    expect(decodeProgramError(failure([]), tables)).toEqual({
      code: 11, name: "MinimumOutputNotMet", message: "Final output is below the signed minimum",
    });
    expect(decodeProgramError(failure(["Program log: forwarded venue failure"]), tables)).toBeNull();
  });
});
