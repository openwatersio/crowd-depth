import { expect, test } from "vitest";
import { Readable } from "node:stream";
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../../src/storage.js";
import {
  createPreviewStore,
  observation,
  scanPreview,
} from "../../src/tiles/preview.js";
import { Timeframe, type BathymetrySource } from "../../src/types.js";
import { config } from "../helper.js";

const hour = 3600000;
const t = Date.parse("2026-10-16T12:00:00Z");
const view = [14, -81, 25, -79, 27] as const;
const point = (time = t, lon = -80) => ({ lon, lat: 26, depth: 6, time });
const sample = (time = t, lon = -80) => ({
  longitude: lon,
  latitude: 26,
  depth: 6,
  timestamp: Temporal.Instant.fromEpochMilliseconds(time),
});

test("preview keeps one recent observation per cell, survives restart, and fences stale publishers", () => {
  const db = createDB(":memory:");
  const first = createPreviewStore(db, "a");
  first.write("local", [point(), point(t - 1000)]);
  expect(first.features(view, 0)).toHaveLength(1);
  expect(first.features(view, 0)[0].properties.time).toBe(t);
  const next = createPreviewStore(db, "a");
  first.write("local", [point(t + 1000, -80.1)], [0, t + 1]);
  expect(next.features(view, 0)).toHaveLength(1);
  expect(next.done("local", 0, t + 1)).toBe(false);
  expect(next.features(view, t + 1)).toEqual([]);
  const changed = createPreviewStore(db, "b");
  expect(changed.features(view, 0)).toEqual([]);
  expect(next.current()).toBe(false);
  db.close();
});

test("settled history replaces local observations only inside its half-open window", () => {
  const db = createDB(":memory:");
  const store = createPreviewStore(db, "a");
  store.write("local", [
    point(t - 1, -80.1),
    point(t, -80.2),
    point(t + 1000, -80.3),
  ]);
  store.write("history", [point(t, -80.4)], [t, t + 1000]);
  expect(
    store
      .features(view, 0)
      .map((f) => f.geometry.coordinates[0])
      .sort((a, b) => a - b),
  ).toEqual([-80.4, -80.3, -80.1]);
  store.write("history", [point(t, -80.4)], [t, t + 1000]);
  expect(store.features(view, 0)).toHaveLength(3);
  db.close();
});

test("preview respects viewport, dateline, output bounds and invalid observations", () => {
  const db = createDB(":memory:");
  const store = createPreviewStore(db, "a");
  store.write("local", [point(t, 179.9), point(t, -179.9), point(t, 0)]);
  expect(store.features([10, 179, 25, -179, 27], 0)).toHaveLength(2);
  expect(store.features(undefined, 0)).toEqual([]);
  store.write(
    "local",
    Array.from({ length: 2000 }, (_, i) => point(t + i, -80.9 + i * 0.0005)),
  );
  expect(store.features(view, 0)).toHaveLength(1200);
  expect(observation({ ...sample(), depth: NaN })).toBeUndefined();
  expect(observation({ ...sample(), latitude: 90 })).toBeUndefined();
  expect(observation({ ...sample(), depth: 0 })).toBeUndefined();
  db.close();
});

test("recent preview publishes before availability discovery completes", async () => {
  const db = createDB(":memory:");
  const store = createPreviewStore(db, "a");
  const abort = new AbortController();
  let started!: () => void;
  const discovered = new Promise<void>((r) => (started = r));
  const source: BathymetrySource = {
    createReader: () => Readable.from([sample(t - 1000)]),
    getAvailableTimeframes: () => {
      started();
      return new Promise(() => {});
    },
  };
  const run = scanPreview({
    source,
    store,
    config,
    signal: abort.signal,
    until: t,
    since: t - 2 * hour,
  });
  await discovered;
  expect(store.features(view, 0)).toHaveLength(1);
  abort.abort();
  await run;
  db.close();
});

test("scanner reads newest windows first, clamps provider output, and resumes completed windows", async () => {
  const db = createDB(":memory:");
  const store = createPreviewStore(db, "a");
  const reads: number[] = [];
  const source: BathymetrySource = {
    createReader: ({ from, to }) => {
      reads.push(from.epochMilliseconds);
      return Readable.from([
        sample(from.epochMilliseconds - 1, -80.1),
        sample(from.epochMilliseconds, -80.2),
        sample(to.epochMilliseconds, -80.3),
      ]);
    },
    getAvailableTimeframes: () => [
      new Timeframe(
        Temporal.Instant.fromEpochMilliseconds(t - 2 * hour),
        Temporal.Instant.fromEpochMilliseconds(t - hour),
      ),
      new Timeframe(
        Temporal.Instant.fromEpochMilliseconds(t - hour),
        Temporal.Instant.fromEpochMilliseconds(t),
      ),
    ],
  };
  const options = {
    source,
    store,
    config,
    signal: new AbortController().signal,
    until: t,
    since: t - 2 * hour,
  };
  await scanPreview(options);
  expect(reads).toEqual([t - hour, t - 2 * hour]);
  expect(store.features(view, 0).map((f) => f.geometry.coordinates[0])).toEqual(
    [-80.2],
  );
  await scanPreview(options);
  expect(reads).toHaveLength(2);
  db.close();
});

test("aborting a delayed source prevents late writes and completion", async () => {
  const db = createDB(":memory:");
  const store = createPreviewStore(db, "a");
  const abort = new AbortController();
  let resolve!: (value: Readable) => void;
  const source: BathymetrySource = {
    createReader: () => new Promise((r) => (resolve = r)),
    getAvailableTimeframes: () => [],
  };
  const run = scanPreview({
    source,
    store,
    config,
    signal: abort.signal,
    until: t,
    since: t - hour,
  });
  await Promise.resolve();
  abort.abort();
  resolve(Readable.from([sample(t - 1)]));
  await run;
  expect(store.features(view, 0)).toEqual([]);
  expect(store.done("history", t - hour, t)).toBe(false);
  db.close();
});

test("spatial hints promote a viewport's older visit before ordinary backwards discovery", async () => {
  const db = createDB(":memory:");
  const store = createPreviewStore(db, "a");
  const order: string[] = [];
  const source: BathymetrySource = {
    createReader: ({ from }) => {
      order.push(String(from.epochMilliseconds));
      return Readable.from([sample(from.epochMilliseconds)]);
    },
    getAvailableTimeframes: () => {
      order.push("discover");
      return [];
    },
    getPreviewTimeframes: async () => [
      new Timeframe(
        Temporal.Instant.fromEpochMilliseconds(t - 10 * hour),
        Temporal.Instant.fromEpochMilliseconds(t - 9 * hour),
      ),
    ],
  };
  await scanPreview({
    source,
    store,
    config,
    signal: new AbortController().signal,
    until: t,
    since: t - 24 * hour,
    view: () => view,
  });
  expect(order.slice(0, 3)).toEqual([
    String(t - hour),
    String(t - 10 * hour),
    "discover",
  ]);
  db.close();
});

test("unavailable spatial provider falls back to temporal discovery", async () => {
  const db = createDB(":memory:");
  const store = createPreviewStore(db, "a");
  let discovered = false;
  const source: BathymetrySource = {
    createReader: () => undefined,
    getPreviewTimeframes: async () => {
      throw new Error("no track provider");
    },
    getAvailableTimeframes: () => {
      discovered = true;
      return [];
    },
  };
  await scanPreview({
    source,
    store,
    config,
    signal: new AbortController().signal,
    until: t,
    since: t - 24 * hour,
    view: () => view,
  });
  expect(discovered).toBe(true);
  db.close();
});
