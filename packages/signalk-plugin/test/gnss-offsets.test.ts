import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { gnssOffsets } from "../src/gnss-offsets.js";
import { getOffsets } from "../src/streams/transforms.js";
import { schema } from "../src/config.js";

function app(mode = "off", length: number | undefined = 10) {
  return {
    config: {
      settings: {
        gnssCorrection: mode,
        gnssSensors: [
          { sensorId: "gps1", $source: "can.1", fromBow: 3, fromCenter: -0.5 },
          { sensorId: "gps2", $source: "gpsd.GP", fromBow: 0, fromCenter: 0 },
        ],
      },
    },
    getPath: () => ({ can: { "1": { n2k: { canName: "abc" } } } }),
    getSelfPath: (path: string) =>
      path === "design.length.value" ? { overall: length } : undefined,
  } as unknown as ServerAPI;
}

test("uses only selected source offsets, preserving zero and starboard sign", () => {
  expect(gnssOffsets(app(), "can.1")).toEqual({ gnss: { x: -0.5, y: 3 } });
  expect(gnssOffsets(app(), "can.abc")).toEqual({ gnss: { x: -0.5, y: 3 } });
  expect(gnssOffsets(app(), "gpsd.GP")).toEqual({ gnss: { x: 0, y: 0 } });
  expect(() => gnssOffsets(app(), "missing")).toThrow("GNSS sensor settings");
});

test("corrected positions use midships without moving the physical antenna metadata", () => {
  const geometry = gnssOffsets(app("both"), "gps1.ccrp");
  expect(geometry).toEqual({
    gnss: { x: -0.5, y: 3 },
    positionOrigin: { x: 0, y: 5 },
  });
  expect(getOffsets({ ...geometry, sounder: { x: 0, y: 5 } }).distance).toBe(0);
  expect(gnssOffsets(app("both"), "can.1").positionOrigin).toBeUndefined();
});

test("does not guess geometry for ambiguous replace streams or missing vessel length", () => {
  expect(() => gnssOffsets(app("replace"), "can.1")).toThrow("replace mode");
  expect(() => gnssOffsets(app("both", 0), "gps1.ccrp")).toThrow(
    "vessel length",
  );
});

test("GPS schema retains height but removes horizontal offset fields and requirements", () => {
  const gps = schema(app()).properties.gnss;
  expect(gps.required).toEqual(["z"]);
  expect(gps.properties).not.toHaveProperty("x");
  expect(gps.properties).not.toHaveProperty("y");
  expect(gps.properties).toHaveProperty("z");
});

test("legacy geometry migrates only when no server sensor configuration exists", () => {
  const empty = {
    config: { settings: {} },
    getPath: () => undefined,
  } as unknown as ServerAPI;
  expect(gnssOffsets(empty, "gps", { x: 0, y: 9 })).toEqual({
    gnss: { x: 0, y: 9 },
  });
  expect(() =>
    gnssOffsets(empty, "gps", { x: 0, y: 9, source: "other" }),
  ).toThrow();
  expect(() => gnssOffsets(empty, "gps", { x: NaN, y: 9 })).toThrow();
  expect(gnssOffsets(app(), "can.1", { x: 100, y: 100 })).toEqual({
    gnss: { x: -0.5, y: 3 },
  });
});
