import type { RuntimeTransaction } from "@arch-network/arch-sdk";
import { hex } from "@scure/base";

/** Decode the Rust fixture bytes; never rebuild its message with the TS compiler. */
export function nativeTransaction(raw: string): RuntimeTransaction {
  const data = hex.decode(raw), view = new DataView(data.buffer);
  let offset = 0;
  const take = (length: number) => { const result = data.slice(offset, offset + length); offset += length; return result; };
  const u8 = () => take(1)[0]!;
  const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value; };
  const version = u32(), signatures = Array.from({ length: u8() }, () => take(64));
  const header = { num_required_signatures: u8(), num_readonly_signed_accounts: u8(), num_readonly_unsigned_accounts: u8() };
  const account_keys = Array.from({ length: u32() }, () => take(32));
  const recent_blockhash = take(32);
  const instructions = Array.from({ length: u32() }, () => ({
    program_id_index: u8(), accounts: Array.from(take(u32())), data: take(u32()),
  }));
  if (offset !== data.length) throw new Error("Unexpected trailing fixture bytes.");
  return { version, signatures, message: { header, account_keys, recent_blockhash, instructions } };
}
