import { vi } from "vitest";
import type * as NetworksModule from "../src/config/networks.js";
import {
  RECORDED_TESTNET, RECORDED_TESTNET_MINTS, RECORDED_TESTNET_PROPAMM, RECORDED_TESTNET_VENUES,
} from "./fixtures/recorded-testnet.js";

// Rust fixtures replay under the deployment they were generated against; see fixtures/recorded-testnet.ts.
vi.mock("../src/config/networks.js", async (importActual) => {
  const actual = await importActual<typeof NetworksModule>();
  return {
    ...actual,
    TESTNET: RECORDED_TESTNET,
    TESTNET_MINTS: RECORDED_TESTNET_MINTS,
    TESTNET_VENUES: RECORDED_TESTNET_VENUES,
    NETWORKS: Object.freeze({
      ...actual.NETWORKS,
      testnet: Object.freeze({
        programs: RECORDED_TESTNET, mints: RECORDED_TESTNET_MINTS, venues: RECORDED_TESTNET_VENUES,
        propamm: RECORDED_TESTNET_PROPAMM,
      }),
    }),
  };
});
