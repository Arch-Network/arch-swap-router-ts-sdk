import {
  MAX_SIGNERS, RUNTIME_TX_SIZE_LIMIT, SanitizedMessageUtil, TransactionUtil, RUNTIME_TX_VERSION,
  type Instruction,
} from "@arch-network/arch-sdk";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { TESTNET } from "../../src/config/testnet.js";
import { buildInstructionBundle } from "../../src/transactions/instructions.js";
import { measureSignedSize } from "../../src/transactions/size.js";
import { buildInputs, fixtures, namedFixture } from "./fixtures.js";

const user = namedFixture("direct-mint-usd").user;
const emptyInstruction: Instruction = { program_id: base58.decode(TESTNET.routerProgramId), accounts: [], data: new Uint8Array() };

function key(index: number): Uint8Array {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index, true);
  return bytes;
}

describe("expected signed size", () => {
  it.each(fixtures)("agrees with the native Rust message size: $name", (fixture) => {
    const { resolved, request } = buildInputs(fixture);
    const instructions = buildInstructionBundle(resolved, request, TESTNET);
    const message = SanitizedMessageUtil.createSanitizedMessage([...instructions], base58.decode(user), new Uint8Array(32));
    if (typeof message === "string") throw new Error(message);
    expect(TransactionUtil.serializedSize({ version: RUNTIME_TX_VERSION, signatures: [new Uint8Array(64)], message })).toBe(fixture.expectedSignedSize);
    if (fixture.expectedSignedSize > RUNTIME_TX_SIZE_LIMIT) {
      expect(() => measureSignedSize(instructions, request.user)).toThrow(
        expect.objectContaining({ code: "TRANSACTION_TOO_LARGE", message: expect.stringContaining("1275") }),
      );
    } else {
      expect(measureSignedSize(instructions, request.user)).toBe(fixture.expectedSignedSize);
    }
  });

  it("accepts exactly the size limit and rejects one additional byte", () => {
    // One signer, two keys, no account positions: 185 bytes before instruction data.
    const atLimit = { ...emptyInstruction, data: new Uint8Array(RUNTIME_TX_SIZE_LIMIT - 185) };
    expect(measureSignedSize([atLimit], user)).toBe(RUNTIME_TX_SIZE_LIMIT);
    expect(() => measureSignedSize([{ ...atLimit, data: new Uint8Array(atLimit.data.length + 1) }], user)).toThrow(
      expect.objectContaining({ code: "TRANSACTION_TOO_LARGE", cause: expect.any(Error) }),
    );
  });

  it("counts each distinct required signer once, including read-only signers", () => {
    const extra = { pubkey: key(7), is_signer: false, is_writable: false };
    const unsigned = { ...emptyInstruction, accounts: [extra, extra] };
    const signed = { ...unsigned, accounts: [{ ...extra, is_signer: true }, extra] };
    expect(measureSignedSize([signed], user) - measureSignedSize([unsigned], user)).toBe(64);
  });

  it("surfaces the SDK compile-error string with its original cause", () => {
    const instruction = {
      ...emptyInstruction,
      accounts: Array.from({ length: 257 }, (_, index) => ({ pubkey: key(index + 1), is_signer: false, is_writable: false })),
    };
    expect(() => measureSignedSize([instruction], user)).toThrow(
      expect.objectContaining({ code: "TRANSACTION_COMPILE_FAILED", cause: "account index overflowed during compilation" }),
    );
  });

  it("preserves serialization failures such as too many signatures", () => {
    const instruction = {
      ...emptyInstruction,
      accounts: Array.from({ length: MAX_SIGNERS }, (_, index) => ({ pubkey: key(index + 1), is_signer: true, is_writable: false })),
    };
    // The payer adds one more signature than the SDK maximum.
    expect(() => measureSignedSize([instruction], user)).toThrow(
      expect.objectContaining({ code: "TRANSACTION_SERIALIZATION_FAILED", cause: expect.any(Error) }),
    );
  });
});
