import { expect, test, vi } from "vitest";
import { createDB } from "../../src/storage.js";
import { createTileStore } from "../../src/tiles/store.js";
import { createTileWriter, getThrough } from "../../src/tiles/writer.js";
import { BASE_ZOOM, lngLatToCell } from "../../src/tiles/core/index.js";
import { Temporal } from "@js-temporal/polyfill";

test("destroying the writer stops its flush timer", () => {
  vi.useFakeTimers();
  const store = createTileStore(createDB(":memory:"));
  const writer = createTileWriter(store, { flushIntervalMs: 100 });
  writer.write({ longitude: 0, latitude: 0, depth: 5 } as never, () => {});

  writer.destroy();
  store.close();

  // The collector destroys writers on stop without ending them; a surviving
  // timer would flush into the closed store and throw from an uncaught callback.
  expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  vi.useRealTimers();
});

test("ending the writer flushes pending soundings", async () => {
  const store = createTileStore(createDB(":memory:"));
  const writer = createTileWriter(store, { flushIntervalMs: 100000 });
  writer.write({ longitude: 0, latitude: 0, depth: 5 } as never, () => {});
  await new Promise<void>((resolve) => writer.end(() => resolve()));

  const { x, y } = lngLatToCell(0, 0, BASE_ZOOM);
  expect(store.read(BASE_ZOOM, x, y)?.size).toBe(1);
});

test("records the time the tiles hold soundings through", async () => {
  const store = createTileStore(createDB(":memory:"));
  const writer = createTileWriter(store, { flushIntervalMs: 100000 });
  const at = (s: string) => Temporal.Instant.from(s);
  for (const timestamp of [
    at("2026-10-16T10:00:00Z"),
    at("2026-10-16T10:00:05Z"),
    at("2026-10-16T10:00:02Z"),
  ]) {
    writer.write({ longitude: 0, latitude: 0, depth: 5, timestamp }, () => {});
  }
  await new Promise<void>((resolve) => writer.end(() => resolve()));

  expect(getThrough(store)?.toString()).toBe("2026-10-16T10:00:05Z");
});
