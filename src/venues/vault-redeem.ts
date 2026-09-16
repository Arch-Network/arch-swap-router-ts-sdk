import { NotImplementedError } from "../errors/index.js";
import type { VaultVenue } from "../types.js";
import type { VenueAdapter } from "./types.js";

export const vaultRedeemAdapter: VenueAdapter<VaultVenue> = {
  operation: "vaultRedeem",

  getConnections(_venue) {
    throw new NotImplementedError("vaultRedeem.getConnections");
  },

  async quoteExactIn(_venue, _step, _amountIn, _context) {
    throw new NotImplementedError("vaultRedeem.quoteExactIn");
  },
};
