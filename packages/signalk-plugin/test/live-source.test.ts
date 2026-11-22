import { expect, test } from "vitest";
import type { Delta, ServerAPI } from "@signalk/server-api";
import { createLiveStream } from "../src/streams/live.js";
import { config } from "./helper.js";

test("live collection uses only the selected source and path, with one depth correction", () => {
  let receive!: (delta: Delta) => void;
  const app = {
    debug: () => {},
    getSelfPath: (path: string) =>
      path === "navigation.position"
        ? {
            value: { longitude: -76, latitude: 38 },
            timestamp: "2026-11-19T01:00:00Z",
          }
        : undefined,
    subscriptionmanager: {
      subscribe: (
        _request: unknown,
        _unsub: unknown,
        _error: unknown,
        callback: typeof receive,
      ) => {
        expect(_request).toMatchObject({
          sourcePolicy: "all",
        });
        receive = callback;
      },
    },
  } as unknown as ServerAPI;
  const stream = createLiveStream(app, {
    ...config,
    path: "belowTransducer",
    sounder: { x: 0, y: 0, z: 0.5, source: "can.35" },
  });
  const emit = (source: string, path: string, value: number) =>
    receive({
      updates: [
        {
          $source: source,
          timestamp: "2026-11-19T01:00:00Z",
          values: [{ path, value }],
        },
      ],
    } as unknown as Delta);
  emit("other.35", "environment.depth.belowTransducer", 100);
  emit("can.35", "environment.depth.belowSurface", 20);
  expect(stream.read()).toBeNull();
  emit("can.35", "environment.depth.belowTransducer", 4);
  expect(stream.read().depth).toBe(4.5);
  emit("can.35", "environment.depth.belowTransducer", 0);
  expect(stream.read()).toBeNull();
  stream.destroy();
});

test("uses the selected GPS value rather than another antenna's prioritized position", () => {
  let receive!: (delta: Delta) => void;
  const timestamp = "2026-11-19T01:00:00Z";
  const app = {
    debug: () => {},
    getSelfPath: (path: string) =>
      path === "navigation.position"
        ? {
            $source: "other",
            value: { longitude: 1, latitude: 2 },
            timestamp,
            values: {
              selected: { value: { longitude: -76, latitude: 38 }, timestamp },
            },
          }
        : undefined,
    subscriptionmanager: {
      subscribe: (
        _request: unknown,
        _unsub: unknown,
        _error: unknown,
        callback: typeof receive,
      ) => {
        receive = callback;
      },
    },
  } as unknown as ServerAPI;
  const stream = createLiveStream(app, {
    ...config,
    path: "belowTransducer",
    gnss: { ...config.gnss, source: "selected" },
  });
  receive({
    updates: [
      {
        timestamp,
        values: [{ path: "environment.depth.belowTransducer", value: 4 }],
      },
    ],
  } as unknown as Delta);
  expect(stream.read()).toMatchObject({ longitude: -76, latitude: 38 });
  stream.destroy();
});

test("matches CAN address and CAN-name aliases for both selected instruments", () => {
  let receive!: (delta: Delta) => void;
  const timestamp = "2026-11-19T01:00:00Z";
  const app = {
    debug: () => {},
    getPath: () => ({
      can: {
        "35": { n2k: { canName: "sounder-name" } },
        "21": { n2k: { canName: "gps-name" } },
      },
    }),
    getSelfPath: (path: string) =>
      path === "navigation.position"
        ? {
            $source: "other",
            values: {
              "can.gps-name": {
                value: { longitude: -76, latitude: 38 },
                timestamp,
              },
            },
          }
        : undefined,
    subscriptionmanager: {
      subscribe: (
        _a: unknown,
        _b: unknown,
        _c: unknown,
        callback: typeof receive,
      ) => {
        receive = callback;
      },
    },
  } as unknown as ServerAPI;
  const stream = createLiveStream(app, {
    ...config,
    path: "belowTransducer",
    sounder: { ...config.sounder, source: "can.35" },
    gnss: { ...config.gnss, source: "can.21" },
  });
  receive({
    updates: [
      {
        $source: "can.sounder-name",
        timestamp,
        values: [{ path: "environment.depth.belowTransducer", value: 4 }],
      },
    ],
  } as unknown as Delta);
  expect(stream.read()).toMatchObject({ longitude: -76, latitude: 38 });
  stream.destroy();
});
