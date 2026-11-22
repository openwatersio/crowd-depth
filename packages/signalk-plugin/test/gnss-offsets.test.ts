import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { gnssOrigin } from "../src/gnss-offsets.js";
import { correctForSensorPosition } from "../src/streams/transforms.js";
import { config } from "./helper.js";
import { Temporal } from "@js-temporal/polyfill";

const cfg = { ...config, gnss: { z: 2 } };
const sensors = [
  { sensorId: "bow", $source: "bus.stable", fromBow: 2, fromCenter: 1 },
  { sensorId: "stern", $source: "gps.two", fromBow: 8, fromCenter: -1 },
];
function app(mode = "off", rows = sensors) {
  return {
    config: { settings: { gnssSensors: rows, gnssCorrection: mode } },
    getPath: () => ({ bus: { "1": { n2k: { canName: "stable" } } } }),
    getSelfPath: (path: string) =>
      path === "design.length.value" ? { overall: 12 } : undefined,
  } as unknown as ServerAPI;
}

test("uses the actual receiver geometry across failover and CAN aliases", () => {
  expect(gnssOrigin(app(), cfg, "bus.1")).toEqual({ x: -1, y: 2 });
  expect(gnssOrigin(app(), cfg, "gps.two")).toEqual({ x: 1, y: 8 });
  expect(gnssOrigin(app(), cfg, "missing")).toBeNull();
});

test("corrected CCRP positions use the boat center rather than antenna location", () => {
  expect(gnssOrigin(app("both"), cfg, "bow.ccrp")).toEqual({ x: 0, y: 6 });
  expect(gnssOrigin(app("both"), cfg, "bus.1")).toEqual({ x: -1, y: 2 });
  expect(gnssOrigin(app("replace"), cfg, "bus.1")).toBeNull();
});

test("legacy saved geometry still works without GNSS sensor settings", () => {
  expect(gnssOrigin(app("off", []), config, "old.gps")).toEqual({ x: 1, y: 2 });
  expect(gnssOrigin(app("off", []), cfg, "old.gps")).toBeNull();
});

test("null server offsets do not become zero or borrow legacy geometry", () => {
  const rows = [{ ...sensors[0], fromBow: null }];
  expect(gnssOrigin(app("off", rows as never), config, "bus.1")).toBeNull();
});

test("recorded origin overrides later settings and avoids a second antenna correction", () => {
  const correct = correctForSensorPosition({
    sounder: { x: 0, y: 2 },
    gnss: { x: 0, y: 99 },
  });
  const point = {
    longitude: 0,
    latitude: 0,
    depth: 3,
    heading: 0,
    timestamp: Temporal.Instant.from("2026-01-01T00:00:00Z"),
  };
  expect(correct({ ...point, positionOrigin: { x: 0, y: 2 } })?.latitude).toBe(
    0,
  );
  const ccrp = correct({ ...point, positionOrigin: { x: 0, y: 6 } });
  expect(ccrp!.latitude).toBeGreaterThan(0.00003);
  expect(ccrp!.latitude).toBeLessThan(0.00004);
  expect(correct({ ...point, positionOrigin: null })).toBeNull();
});

test("never borrows legacy geometry for unknown history or failover with server rows", () => {
  expect(gnssOrigin(app("replace"), config)).toBeNull();
  expect(gnssOrigin(app(), config, "unknown")).toBeNull();
  expect(gnssOrigin(app("off"), cfg, "bow.ccrp")).toEqual({ x: 0, y: 6 });
});

test("chart invalidation includes sounder geometry without legacy GPS offsets", async () => {
  const { cellConfig } = await import("../src/chart.js");
  expect(cellConfig(cfg).position).not.toBe(
    cellConfig({ ...cfg, sounder: { ...cfg.sounder, y: 99 } }).position,
  );
  expect(cellConfig(cfg, app()).position).not.toBe(
    cellConfig(cfg, app("both")).position,
  );
});

test("unlinked rows do not disable legacy geometry and deleted rows do not change CCRP", () => {
  expect(
    gnssOrigin(app("off", [{ ...sensors[0], $source: "" }]), config, "old.gps"),
  ).toEqual({ x: 1, y: 2 });
  expect(gnssOrigin(app("off", []), config, "old.ccrp")).toEqual({
    x: 0,
    y: 6,
  });
});

test("sounder defaults convert the server's port-positive sign", async () => {
  const { schema } = await import("../src/config.js");
  const api = app("off", []);
  api.getSelfPath = ((path: string) =>
    path === "sensors.depth.fromCenter.value"
      ? 1.5
      : undefined) as typeof api.getSelfPath;
  expect(schema(api).properties.sounder.properties.x.default).toBe(-1.5);
});

test("unlinked server rows cannot revive stale server-wide offsets", () => {
  const api = app("off", [{ ...sensors[0], $source: "" }]);
  api.getSelfPath = ((path: string) =>
    path === "sensors.gps.fromBow.value"
      ? 5
      : path === "sensors.gps.fromCenter.value"
        ? 0
        : undefined) as typeof api.getSelfPath;
  expect(gnssOrigin(api, cfg, "gps.one")).toBeNull();
  expect(gnssOrigin(api, config, "gps.one")).toEqual({ x: 1, y: 2 });
});

test("canonical duplicate sensor rows use the server's last valid geometry", () => {
  const rows = [
    sensors[0],
    { ...sensors[0], $source: "bus.1", fromBow: 7, fromCenter: 2 },
  ];
  expect(gnssOrigin(app("off", rows), cfg, "bus.1")).toEqual({ x: -2, y: 7 });
});
