import { RouterSdkError } from "../errors/index.js";
import type { RouteResultV1 } from "./types.js";

/** Decode framing only; the caller must verify success, rollback, and publisher. */
export function decodeRouteResultV1(data: Uint8Array): RouteResultV1 {
  if (data.byteLength !== 17) {
    throw new RouterSdkError("INVALID_RESULT_LENGTH", "Route result must contain exactly 17 bytes.");
  }
  if (data[0] !== 1) {
    throw new RouterSdkError(
      "UNSUPPORTED_RESULT_VERSION",
      `Unsupported route result version ${data[0]}.`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    version: 1,
    amountIn: view.getBigUint64(1, true),
    amountOut: view.getBigUint64(9, true),
  };
}
