import { NotImplementedError } from "../errors/index.js";
import type { VaultVenue } from "../types.js";
import type { VenueAdapter } from "./types.js";

export const vaultMintAdapter: VenueAdapter<VaultVenue> = {
  operation: "vaultMint",

  getConnections(_venue) {
    throw new NotImplementedError("vaultMint.getConnections");
  },

  async quoteExactIn(_venue, _step, _amountIn, _context) {
    throw new NotImplementedError("vaultMint.quoteExactIn");
  },
};
