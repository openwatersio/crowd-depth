import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";
import { liveGnssQuality, qualityValue } from "../src/gnss-quality.js";
import { recordedQuality } from "../src/quality-recorder.js";
import { createDB } from "../src/storage.js";
const timestamp = Temporal.Instant.from("2026-01-01T00:00:00Z");
const app = (nodes: Record<string, unknown>) =>
  ({
    getSelfPath: (path: string) => nodes[path],
    getPath: () => ({}),
    config: {
      settings: { gnssSensors: [{ sensorId: "bow", $source: "gps.one" }] },
    },
  }) as unknown as ServerAPI;

test("quality belongs to the receiver and fix, including corrected positions", () => {
  const api = app({
    "navigation.gnss.satellites": {
      $source: "gps.two",
      value: 99,
      timestamp: timestamp.toString(),
      values: { "gps.one": { value: 8, timestamp: timestamp.toString() } },
    },
    "navigation.gnss.horizontalDilution": {
      $source: "gps.one",
      value: 1,
      timestamp: timestamp.subtract({ seconds: 3 }).toString(),
    },
    "navigation.gnss.methodQuality": {
      $source: "gps.one",
      value: "DGNSS fix",
      timestamp: timestamp.toString(),
    },
  });
  expect(liveGnssQuality(api, "gps.one", timestamp)).toEqual({
    satellites: 8,
    methodQuality: "DGNSS fix",
  });
  expect(liveGnssQuality(api, "bow.ccrp", timestamp)).toEqual({
    satellites: 8,
    methodQuality: "DGNSS fix",
  });
  expect(liveGnssQuality(api, "missing", timestamp)).toBeUndefined();
  expect(qualityValue("satellites", NaN)).toBeUndefined();
  expect(qualityValue("methodQuality", "")).toBeUndefined();
});

test("local quality matches time, coordinates and source without guessing an unidentified receiver", () => {
  const db = createDB(":memory:");
  const api = app({});
  const point = { timestamp, longitude: 1, latitude: 2, depth: 3 };
  const insert = db.prepare("INSERT INTO gnss_samples VALUES(?,?,?,?,?)");
  insert.run(
    timestamp.epochMilliseconds + 100,
    1,
    2,
    "gps.one",
    JSON.stringify({ satellites: 8 }),
  );
  expect(recordedQuality(api, db, point)).toBeUndefined();
  expect(recordedQuality(api, db, point, "gps.one")).toEqual({ satellites: 8 });
  expect(
    recordedQuality(api, db, { ...point, longitude: 3 }, "gps.one"),
  ).toBeUndefined();
  expect(
    recordedQuality(
      api,
      db,
      {
        ...point,
        timestamp: timestamp.add({ seconds: 1 }),
      },
      "gps.one",
    ),
  ).toBeUndefined();
  insert.run(
    timestamp.epochMilliseconds + 100,
    1,
    2,
    "gps.two",
    JSON.stringify({ satellites: 12 }),
  );
  expect(recordedQuality(api, db, point)).toBeUndefined();
  expect(recordedQuality(api, db, point, "gps.one")).toEqual({ satellites: 8 });
  db.close();
});
