import { NotImplementedError } from "../errors/index.js";
import type { ClammVenue } from "../types.js";
import type { VenueAdapter } from "./types.js";

export const clammAdapter: VenueAdapter<ClammVenue> = {
  operation: "clamm",

  getConnections(_venue) {
    throw new NotImplementedError("clamm.getConnections");
  },

  async quoteExactIn(_venue, _step, _amountIn, _context) {
    throw new NotImplementedError("clamm.quoteExactIn");
  },
};
