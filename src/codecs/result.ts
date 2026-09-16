import { NotImplementedError } from "../errors/index.js";
import type { RouteResultV1 } from "./types.js";

export function decodeRouteResultV1(_data: Uint8Array): RouteResultV1 {
  throw new NotImplementedError("decodeRouteResultV1");
}
