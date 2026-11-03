import { TransactionUtil, type SanitizedMessage } from "@arch-network/arch-sdk";
import { hex } from "@scure/base";

/** Synthetic compiled messages exercise limits that the current native routes fit. */
export function withPacketSize(message: SanitizedMessage, size: number): SanitizedMessage {
  const copy = structuredClone(message);
  const signatures = Array.from({ length: copy.header.num_required_signatures }, () => new Uint8Array(64));
  const current = TransactionUtil.serializedSize({ version: 0, message: copy, signatures });
  const instruction = copy.instructions.at(-1)!;
  const data = new Uint8Array(instruction.data.length + size - current);
  data.set(instruction.data);
  instruction.data = data;
  return copy;
}

export function withAccountCount(message: SanitizedMessage, count: number): SanitizedMessage {
  const copy = structuredClone(message);
  if (count < copy.account_keys.length) throw new Error("Cannot remove required fixture accounts.");
  const seen = new Set(copy.account_keys.map(hex.encode));
  for (let index = 0; copy.account_keys.length < count; index++) {
    const key = new Uint8Array(32).fill(0xf0);
    new DataView(key.buffer).setUint32(0, index, true);
    const encoded = hex.encode(key);
    if (seen.has(encoded)) continue;
    seen.add(encoded);
    copy.account_keys.push(key);
    copy.header.num_readonly_unsigned_accounts++;
  }
  return copy;
}
