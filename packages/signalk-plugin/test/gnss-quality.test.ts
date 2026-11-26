import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";
import { liveGnssQuality } from "../src/gnss-quality.js";

const now = Temporal.Instant.from("2026-11-19T02:00:00Z");
test("quality follows the chosen GPS and rejects stale, future and malformed values", () => {
  const paths: Record<string, unknown> = {
    satellites: {
      $source: "other",
      value: 99,
      timestamp: now.toString(),
      values: { gps: { value: 12, timestamp: now.toString() } },
    },
    horizontalDilution: {
      $source: "gps",
      value: 0.7,
      timestamp: now.subtract({ seconds: 1 }).toString(),
    },
    positionDilution: {
      $source: "gps",
      value: 2,
      timestamp: now.subtract({ seconds: 3 }).toString(),
    },
    methodQuality: {
      $source: "gps",
      value: "DGNSS fix",
      timestamp: now.toString(),
    },
    integrity: {
      $source: "gps",
      value: "Safe",
      timestamp: now.add({ seconds: 1 }).toString(),
    },
    antennaAltitude: { $source: "gps", value: NaN, timestamp: now.toString() },
    geoidalSeparation: { $source: "gps", value: -29, timestamp: "bad" },
  };
  const app = {
    getSelfPath: (path: string) => paths[path.split(".").at(-1)!],
  } as unknown as ServerAPI;
  expect(liveGnssQuality(app, "gps", now)).toEqual({
    satellites: 12,
    horizontalDilution: 0.7,
    methodQuality: "DGNSS fix",
  });
  expect(liveGnssQuality(app, undefined, now)).toBeUndefined();
});

test.each([true, false])(
  "quality accepts a receiver's CAN-name alias (active=%s)",
  (active) => {
    const app = {
      getPath: () => ({ bus: { "35": { n2k: { canName: "stable" } } } }),
      getSelfPath: (path: string) =>
        path.endsWith("satellites")
          ? {
              $source: active ? "bus.35" : "other.35",
              value: active ? 12 : 99,
              timestamp: now.toString(),
              values: { "bus.35": { value: 12, timestamp: now.toString() } },
            }
          : undefined,
    } as unknown as ServerAPI;
    expect(liveGnssQuality(app, "bus.stable", now)).toEqual({ satellites: 12 });
    expect(liveGnssQuality(app, "different.stable", now)).toBeUndefined();
    expect(
      liveGnssQuality(app, "bus.stable", now.add({ seconds: 3 })),
    ).toBeUndefined();
  },
);

test.each([true, false])(
  "fresh receiver quality survives a stale CAN alias (active=%s)",
  (active) => {
    const app = {
      getPath: () => ({
        bus: {
          "35": { n2k: { canName: "stable" } },
          "36": { n2k: { canName: "stable" } },
        },
      }),
      getSelfPath: (path: string) =>
        path.endsWith("satellites")
          ? {
              $source: active ? "bus.35" : "other.1",
              value: 7,
              timestamp: now.subtract({ seconds: 10 }).toString(),
              values: {
                "bus.35": {
                  value: 7,
                  timestamp: now.subtract({ seconds: 10 }).toString(),
                },
                "bus.36": { value: 12, timestamp: now.toString() },
              },
            }
          : undefined,
    } as unknown as ServerAPI;
    expect(liveGnssQuality(app, "bus.stable", now)).toEqual({ satellites: 12 });
  },
);
