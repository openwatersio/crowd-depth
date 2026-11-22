import { expect, test, vi } from "vitest";
import type { Delta, ServerAPI, SubscribeMessage } from "@signalk/server-api";
import { createLiveStream } from "../src/streams/live.js";
import { config } from "./helper.js";

function setup(depth = "", gps = "") {
  const subscriptions: {
    command: SubscribeMessage;
    callback: (d: Delta) => void;
  }[] = [];
  const unsubscribe = vi.fn();
  const app = {
    debug: vi.fn(),
    error: vi.fn(),
    getSelfPath: () => undefined,
    getPath: () => ({ bus: { "35": { n2k: { canName: "stable" } } } }),
    subscriptionmanager: {
      subscribe(
        command: SubscribeMessage,
        unsubs: (() => void)[],
        _error: unknown,
        callback: (d: Delta) => void,
      ) {
        subscriptions.push({ command, callback });
        unsubs.push(unsubscribe);
      },
    },
  } as unknown as ServerAPI;
  const stream = createLiveStream(app, {
    ...config,
    path: "belowTransducer",
    sounder: { ...config.sounder, z: 0, source: depth },
    gnss: { ...config.gnss, source: gps },
  });
  const send = (
    path: string,
    source: string,
    value: unknown,
    time = "2026-01-01T00:00:00Z",
  ) => {
    const sub = subscriptions.find(
      (s) => s.command.subscribe[0].path === path,
    )!;
    sub.callback({
      context: "vessels.self",
      updates: [
        { $source: source, timestamp: time, values: [{ path, value }] },
      ],
    } as Delta);
  };
  return { app, stream, subscriptions, send, unsubscribe };
}
const position = "navigation.position";
const depth = "environment.depth.belowTransducer";

test("preferred subscriptions follow independent position and depth failover", () => {
  const s = setup();
  expect(s.subscriptions.map((s) => s.command.sourcePolicy)).toEqual([
    "preferred",
    "preferred",
  ]);
  s.send(position, "gps.one", { longitude: 1, latitude: 2 });
  s.send(depth, "depth.one", 3);
  expect(s.stream.read()).toMatchObject({
    longitude: 1,
    latitude: 2,
    depth: 3,
  });
  s.send(position, "gps.two", { longitude: 4, latitude: 5 });
  s.send(depth, "depth.two", 6);
  expect(s.stream.read()).toMatchObject({
    longitude: 4,
    latitude: 5,
    depth: 6,
  });
  s.stream.destroy();
});

test.each([
  ["depth.chosen", ""],
  ["", "gps.chosen"],
  ["depth.chosen", "gps.chosen"],
])("mixed selections depth=%s gps=%s keep independent policies", (d, g) => {
  const s = setup(d, g);
  expect(s.subscriptions.map((s) => s.command.sourcePolicy)).toEqual([
    g ? "all" : "preferred",
    d ? "all" : "preferred",
  ]);
  s.send(position, g || "gps.preferred", { longitude: 1, latitude: 2 });
  if (g) s.send(position, "gps.other", { longitude: 99, latitude: 99 });
  if (d) {
    s.send(depth, "depth.other", 9);
    expect(s.stream.read()).toBeNull();
  }
  s.send(depth, d || "depth.preferred", 3);
  expect(s.stream.read()).toMatchObject({
    longitude: 1,
    latitude: 2,
    depth: 3,
  });
  s.stream.destroy();
});

test("explicit CAN-name selection accepts its numeric-address alias", () => {
  const s = setup("bus.stable", "bus.stable");
  s.send(position, "bus.35", { longitude: 1, latitude: 2 });
  s.send(depth, "bus.35", 3);
  expect(s.stream.read()).toMatchObject({ depth: 3, longitude: 1 });
  s.send(depth, "other.35", 4);
  expect(s.stream.read()).toBeNull();
  s.stream.destroy();
});

test("missing, invalid, or stale selected position never falls back to another receiver", () => {
  const s = setup("", "gps.chosen");
  s.send(position, "gps.other", { longitude: 1, latitude: 2 });
  s.send(depth, "depth.one", 3);
  expect(s.stream.read()).toBeNull();
  s.send(position, "gps.chosen", { longitude: 1, latitude: 2 });
  s.send(depth, "depth.one", 3, "2026-01-01T00:00:03Z");
  expect(s.stream.read()).toBeNull();
  s.send(position, "gps.chosen", null);
  s.send(depth, "depth.one", 3);
  expect(s.stream.read()).toBeNull();
  s.stream.destroy();
});

test("zero and invalid depth remain excluded", () => {
  const s = setup();
  s.send(position, "gps.one", { longitude: 1, latitude: 2 });
  for (const value of [0, null, NaN, Infinity])
    s.send(depth, "depth.one", value);
  expect(s.stream.read()).toBeNull();
  s.stream.destroy();
});

test("source choices invalidate chart fingerprints including SQLite history cutoff", async () => {
  const { cellConfig } = await import("../src/chart.js");
  const before = cellConfig(config);
  expect(
    cellConfig({ ...config, gnss: { ...config.gnss, source: "gps.other" } })
      .depth,
  ).not.toBe(before.depth);
  expect(
    cellConfig({
      ...config,
      sounder: { ...config.sounder, source: "depth.other" },
    }).depth,
  ).not.toBe(before.depth);
});

test("missing GPS geometry remains an error until the actual receiver recovers", async () => {
  const { createStatus } = await import("../src/status.js");
  const s = setup();
  const settings = {
    gnssSensors: [
      { sensorId: "one", $source: "gps.one", fromBow: 2, fromCenter: 1 },
    ],
  };
  Object.assign(s.app, {
    config: { settings },
    setPluginError: vi.fn(),
    setPluginStatus: vi.fn(),
  });
  const status = createStatus(s.app);
  s.send(position, "gps.other", { longitude: 1, latitude: 2 });
  s.send(depth, "depth.one", 3);
  expect(s.stream.read()).toBeNull();
  status.set({ collecting: true });
  expect(s.app.setPluginError).toHaveBeenLastCalledWith(
    expect.stringContaining("GPS geometry unavailable"),
  );
  s.send(position, "gps.one", { longitude: 1, latitude: 2 });
  s.send(depth, "depth.one", 3);
  expect(s.stream.read().positionOrigin).toEqual({ x: -1, y: 2 });
  expect(s.app.setPluginStatus).toHaveBeenLastCalledWith(
    "Collecting bathymetry",
  );
  s.stream.destroy();
});

test("a later quality update is not attached to an earlier cached position", () => {
  const s = setup();
  s.app.getSelfPath = ((path: string) =>
    path === "navigation.gnss.methodQuality"
      ? {
          $source: "gps.one",
          value: "RTK Fixed",
          timestamp: "2026-01-01T00:00:01Z",
        }
      : undefined) as typeof s.app.getSelfPath;
  s.send(position, "gps.one", { longitude: 1, latitude: 2 });
  s.send(depth, "depth.one", 3, "2026-01-01T00:00:01.500Z");
  expect(s.stream.read().gnss).toBeUndefined();
  s.stream.destroy();
});
