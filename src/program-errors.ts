import { programErrorTable, type IdlErrorEntry, type ProgramErrorTable } from "@arch-network/arch-sdk";

// The `errors` array of `arch-swap-router` `idl/arch_swap_router.idl.json` (revision 63c37f5), which the program's
// `tests/idl.rs` checks against `src/error.rs` `RouterError`. Copy: tests/fixtures/idl/.
export const ROUTER_ERRORS: readonly IdlErrorEntry[] = [
  { code: 1, name: "InvalidInstruction", msg: "Invalid instruction encoding" },
  { code: 2, name: "InvalidRoute", msg: "Invalid or unsupported route" },
  { code: 3, name: "UnsupportedProgram", msg: "Unexpected program ID" },
  { code: 4, name: "InvalidAccounts", msg: "Invalid route accounts" },
  { code: 5, name: "InvalidToken", msg: "Invalid mint or token account" },
  { code: 6, name: "MissingSignature", msg: "Missing required signature" },
  { code: 7, name: "RouteExpired", msg: "Route deadline has passed" },
  { code: 8, name: "AccountAlias", msg: "Route accounts must be distinct" },
  { code: 9, name: "InsufficientInput", msg: "Insufficient input token balance" },
  { code: 10, name: "IncompleteFill", msg: "Hop did not fully consume input and credit output" },
  { code: 11, name: "MinimumOutputNotMet", msg: "Final output is below the signed minimum" },
  { code: 12, name: "InvalidRfqTerms", msg: "Invalid RFQ terms" },
  { code: 13, name: "RfqExpired", msg: "RFQ quote has expired" },
  { code: 14, name: "NonImmediateRedemption", msg: "Redemption did not fill immediately" },
  { code: 15, name: "ArithmeticOverflow", msg: "Arithmetic overflow" },
  { code: 16, name: "NotImplemented", msg: "Operation is not implemented" },
];

/**
 * The router forwards a failed venue CPI's code unchanged (`src/adapters/*.rs` `invoke(...)`), so a custom code under
 * the router's instruction is only the router's own when no inner program logged: decode empty-log failures only.
 */
export function routerProgramErrorTable(): ProgramErrorTable {
  return programErrorTable(ROUTER_ERRORS, { decodesWithLogs: false });
}
