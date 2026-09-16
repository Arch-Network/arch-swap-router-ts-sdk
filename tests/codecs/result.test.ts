import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { decodeRouteResultV1 } from "../../src/codecs/result.js";
import { RouterSdkError } from "../../src/errors/index.js";
import fixtures from "../fixtures/router-codec/v1.json" with { type: "json" };

// Literal byte order from tests/route_result.rs, independent of the SDK decoder.
const wire = Uint8Array.of(1, 8, 7, 6, 5, 4, 3, 2, 1, 0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11);

describe("RouteResultV1 decoding", () => {
  it.each(fixtures.results)("matches the Rust fixture: $name", (fixture) => {
    expect(decodeRouteResultV1(hex.decode(fixture.hex))).toEqual({
      version: 1,
      amountIn: BigInt(fixture.amountIn),
      amountOut: BigInt(fixture.amountOut),
    });
  });

  it("reads only the supplied byte view, including an unaligned offset", () => {
    const backing = new Uint8Array(32).fill(255);
    backing.set(wire, 3);
    expect(decodeRouteResultV1(backing.subarray(3, 20))).toEqual({
      version: 1,
      amountIn: 0x0102_0304_0506_0708n,
      amountOut: 0x1112_1314_1516_1718n,
    });
  });

  it.each([...Array.from({ length: 17 }, (_, length) => length), 18, 25, 32, 1_024])(
    "rejects a %i-byte result",
    (length) => {
      const bytes = new Uint8Array(length);
      bytes.set(wire.subarray(0, Math.min(length, wire.length)));
      expect(() => decodeRouteResultV1(bytes)).toThrow(RouterSdkError);
      expect(() => decodeRouteResultV1(bytes)).toThrow(
        expect.objectContaining({ code: "INVALID_RESULT_LENGTH" }),
      );
    },
  );

  it("rejects every unsupported version byte", () => {
    for (let version = 0; version <= 255; version++) {
      if (version === 1) continue;
      const bytes = wire.slice();
      bytes[0] = version;
      expect(() => decodeRouteResultV1(bytes)).toThrow(RouterSdkError);
      expect(() => decodeRouteResultV1(bytes)).toThrow(
        expect.objectContaining({ code: "UNSUPPORTED_RESULT_VERSION" }),
      );
    }
  });
});
