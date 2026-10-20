import { expect, test, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../../src/storage.js";
import {
  createCellStore,
  createCellWriter,
  getThrough,
  type Changed,
} from "../../src/tiles/index.js";
import type { BathymetryData } from "../../src/types.js";
import { trackQC } from "../../src/qc.js";
import { DEFINITIONS } from "../../src/tiles/geometry.js";

const start = Temporal.Instant.from("2026-10-16T08:00:00Z");

/** A track north along a meridian at about 6 kn, a sounding every 10 s. */
function track(
  n: number,
  {
    from = 0,
    lon = -76.2,
    at = start,
    depth = (i: number) => 5 + (i % 3) * 0.1,
  } = {},
): BathymetryData[] {
  return Array.from({ length: n }, (_, i) => ({
    latitude: 36.98 + (from + i) * 0.0003,
    longitude: lon,
    depth: depth(i),
    timestamp: at.add({ seconds: i * 10 }),
  }));
}

function run(data: BathymetryData[], onChange?: (c: Changed) => void) {
  const store = createCellStore(createDB(":memory:"));
  const writer = createCellWriter(store, {
    flushIntervalMs: 100_000,
    onChange,
  });
  for (const d of data) writer.write(d, () => {});
  return { store, writer };
}

const end = (writer: { end: (cb: () => void) => void }) =>
  new Promise<void>((resolve) => writer.end(() => resolve()));

test("each crossing of a cell is one pass, and only sounded cells get one", async () => {
  const later = start.add({ hours: 5 });
  const { store, writer } = run([
    ...track(30),
    ...track(30, { at: later, depth: (i) => 6 + (i % 3) * 0.1 }),
  ]);
  await end(writer);
  const cells = store.cells(-76.3, 36, -76.1, 37.1);
  // A sounding every 33 m in 20.5 m rows: one cell each, and none for the rows
  // between, which only neighbouring soundings reached.
  expect(cells).toHaveLength(30);
  for (const c of cells) {
    expect(c.passes).toBe(2);
    // Second pass 1 m deeper: m moves a fifth of the way.
    expect(c.m).toBeGreaterThan(5.1);
    expect(c.m).toBeLessThan(5.5);
  }
});

test("a shoal spike is kept as an unconfirmed shoal, out of the cells", async () => {
  const { store, writer } = run(
    track(40, { depth: (i) => (i === 20 ? 1 : 8) }),
  );
  await end(writer);
  const shoals = store.shoals(-76.3, 36, -76.1, 37.1);
  expect(shoals.map((s) => s.depth)).toEqual([1]);
  for (const c of store.cells(-76.3, 36, -76.1, 37.1)) expect(c.m).toBe(8);
});

test("soundings draw as provisional until their cell is written", async () => {
  const changed: Changed[] = [];
  const { store, writer } = run(track(40), (c) => changed.push(c));
  expect(writer.provisional()).toHaveLength(40);
  expect(store.cells(-76.3, 36, -76.1, 37.1)).toHaveLength(0);
  await end(writer);
  expect(writer.provisional()).toHaveLength(0);
  expect(changed.flat().length).toBe(
    store.cells(-76.3, 36, -76.1, 37.1).length,
  );
});

test("the marker stays before soundings still held, so a restart backfills them", () => {
  const store = createCellStore(createDB(":memory:"));
  const writer = createCellWriter(store, { flushIntervalMs: 100_000 });
  for (const d of track(40)) writer.write(d, () => {});
  // A plugin stop destroys the writer, which writes only closed passes.
  writer.destroy();
  const through = getThrough(store)!;
  const lastWritten = start.add({ seconds: 39 * 10 });
  expect(Temporal.Instant.compare(through, start)).toBeGreaterThanOrEqual(0);
  expect(Temporal.Instant.compare(through, lastWritten)).toBeLessThan(0);
});

test("a stuck sounder's run isn't judged until it covers a kilometre", () => {
  // 25 soundings 33 m apart: one depth for 800 m, which may yet be a stuck sounder.
  const { store, writer } = run(track(25, { depth: () => 2.4 }));
  expect(writer.provisional()).toHaveLength(25);
  writer.destroy();
  expect(store.cells(-76.3, 36, -76.1, 37.1)).toHaveLength(0);
});

test("a stuck run QC sets aside still shows, as unconfirmed soundings", async () => {
  const { store, writer } = run(track(40, { depth: () => 2.4 }));
  await end(writer);
  expect(writer.provisional()).toHaveLength(0);
  expect(store.cells(-76.3, 36, -76.1, 37.1)).toHaveLength(0);
  expect(store.shoals(-76.3, 36, -76.1, 37.1)).toHaveLength(40);
});

test("a position that jumped is dropped, not shown", async () => {
  const data = track(30);
  data[15] = { ...data[15], latitude: data[15].latitude + 0.05 };
  const { store, writer } = run(data);
  await end(writer);
  const shoals = store.shoals(-76.3, 36, -76.1, 37.1);
  expect(shoals.some((s) => s.lat > 37)).toBe(false);
});

test("readings under half a metre stay in the cells, as the grid keeps them", async () => {
  const { store, writer } = run(
    track(30, { depth: (i) => 0.3 + (i % 3) * 0.01 }),
  );
  await end(writer);
  expect(store.cells(-76.3, 36, -76.1, 37.1)).toHaveLength(30);
});

test("a boat at anchor folds its water in every few minutes, holding little", async () => {
  // Two hours swinging within a few metres, 1 Hz, the sounder steady to the centimetre.
  vi.useFakeTimers();
  const store = createCellStore(createDB(":memory:"));
  const writer = createCellWriter(store);
  let most = 0;
  for (let i = 0; i < 2 * 3600; i++) {
    vi.advanceTimersByTime(1000);
    writer.write(
      {
        latitude: 36.98 + Math.sin(i / 300) * 0.00002,
        longitude: -76.2 + Math.cos(i / 300) * 0.00002,
        depth: 4.2,
        timestamp: start.add({ seconds: i }),
      },
      () => {},
    );
    if (i % 60 === 0) most = Math.max(most, writer.provisional().length);
  }
  vi.useRealTimers();
  await end(writer);
  // A run of one depth is held for an hour at most, and a pass for 10 minutes.
  expect(most).toBeLessThan(3600 + 700);
  const cells = store.cells(-76.3, 36, -76.1, 37.1);
  expect(cells.length).toBeGreaterThan(0);
  expect(Math.max(...cells.map((c) => c.passes))).toBeGreaterThan(5);
}, 30_000);

test("a slow stuck sounder is judged whole, as the grid judges it", async () => {
  // 1.5 kn, 1 Hz: 0.77 m a sounding, stuck at 40 m for 2 km in 5 m of water.
  const { store, writer } = run(
    Array.from({ length: 2600 + 100 }, (_, i) => ({
      latitude: 36.98 + (i * 0.77) / 110540,
      longitude: -76.2,
      depth: i >= 100 ? 40 : 5 + (i % 3) * 0.1,
      timestamp: start.add({ seconds: i }),
    })),
  );
  await end(writer);
  const cells = store.cells(-76.3, 36, -76.1, 37.1);
  expect(cells.length).toBeGreaterThan(0);
  expect(Math.max(...cells.map((c) => c.m))).toBeLessThan(10);
});

test("a deep spike isn't shown: drawn, it would read deeper than the water", async () => {
  const { store, writer } = run(
    track(40, { depth: (i) => (i === 20 ? 30 : 8) }),
  );
  await end(writer);
  expect(store.shoals(-76.3, 36, -76.1, 37.1)).toEqual([]);
});

test("held passes wait for the backfill, then go in after it", async () => {
  const store = createCellStore(createDB(":memory:"));
  const writer = createCellWriter(store, { flushIntervalMs: 100_000 });
  writer.hold(true);
  for (const d of track(40)) writer.write(d, () => {});
  // A flush while held writes nothing.
  writer.hold(true);
  expect(store.cells(-76.3, 36, -76.1, 37.1)).toHaveLength(0);
  writer.hold(false);
  expect(store.cells(-76.3, 36, -76.1, 37.1).length).toBeGreaterThan(0);
  writer.destroy();
});

test("a flush that fails once is written whole on the next", async () => {
  const store = createCellStore(createDB(":memory:"));
  const real = store.addPasses;
  let fail = true;
  store.addPasses = (passes, overviews) => {
    if (fail) {
      fail = false;
      throw new Error("database is locked");
    }
    return real(passes, overviews);
  };
  vi.useFakeTimers();
  const writer = createCellWriter(store, { flushIntervalMs: 100 });
  for (const d of track(40)) writer.write(d, () => {});
  vi.advanceTimersByTime(250);
  vi.useRealTimers();
  expect(writer.destroyed).toBe(false);
  await end(writer);
  expect(store.cells(-76.3, 36, -76.1, 37.1)).toHaveLength(40);
});

test("a long steady run at anchor reaches the cells, then QC picks up again", async () => {
  // 10 Hz for 40 minutes at one depth, swinging within 20 m, then the depth moves.
  const { store, writer } = run(
    Array.from({ length: 26_000 }, (_, i) => ({
      latitude: 36.98 + Math.sin(i / 3000) * 0.0001,
      longitude: -76.2 + Math.cos(i / 3000) * 0.0001,
      depth: i < 24_000 ? 5 : 5.5 + (i % 3) * 0.1,
      timestamp: start.add({ milliseconds: i * 100 }),
    })),
  );
  await end(writer);
  const cells = store.cells(-76.3, 36, -76.1, 37.1);
  expect(cells.length).toBeGreaterThan(0);
  // Both depths reached the cells: the run wasn't taken for a stuck sounder.
  expect(Math.min(...cells.map((c) => c.m))).toBeLessThan(5.2);
  expect(Math.max(...cells.map((c) => c.m))).toBeGreaterThan(5.2);
  expect(store.shoals(-76.3, 36, -76.1, 37.1)).toEqual([]);
}, 30_000);

test("a sounder stuck at a mooring and still stuck under way is caught as it leaves", async () => {
  // 1 Hz: 65 minutes swinging at a mooring, then 2 km north at 1.5 kn, stuck at 40 m.
  const moored = 65 * 60;
  const { store, writer } = run(
    Array.from({ length: moored + 2600 }, (_, i) => ({
      latitude:
        36.98 +
        (i < moored
          ? Math.sin(i / 300) * 0.0001
          : ((i - moored) * 0.77) / 110540),
      longitude: -76.2,
      depth: 40,
      timestamp: start.add({ seconds: i }),
    })),
  );
  await end(writer);
  const away = store.cells(-76.3, 36.985, -76.1, 37.1).filter((c) => c.m > 30);
  expect(away).toEqual([]);
}, 30_000);

test("a long stretch where the sounder lost the bottom isn't drawn", async () => {
  // 10 Hz at 5 kn over 6 m, reading 60 to 90 m for 30 s.
  const { store, writer } = run(
    Array.from({ length: 1200 }, (_, i) => ({
      latitude: 36.98 + (i * 0.257) / 110540,
      longitude: -76.2,
      depth: i >= 400 && i < 700 ? 60 + (i % 30) : 6 + (i % 3) * 0.1,
      timestamp: start.add({ milliseconds: i * 100 }),
    })),
  );
  await end(writer);
  const cells = store.cells(-76.3, 36, -76.1, 37.1);
  expect(cells.length).toBeGreaterThan(0);
  expect(Math.max(...cells.map((c) => c.m))).toBeLessThan(10);
});

test("a sounder stuck at a mooring at 10 Hz is caught as it leaves", async () => {
  // 65 minutes at a mooring, then 2 km north at 1.5 kn, stuck at 40 m throughout.
  const moored = 65 * 600;
  const { store, writer } = run(
    Array.from({ length: moored + 26_000 }, (_, i) => ({
      latitude:
        36.98 +
        (i < moored
          ? Math.sin(i / 3000) * 0.0001
          : ((i - moored) * 0.077) / 110540),
      longitude: -76.2,
      depth: 40,
      timestamp: start.add({ milliseconds: i * 100 }),
    })),
  );
  await end(writer);
  const away = store.cells(-76.3, 36.983, -76.1, 37.1).filter((c) => c.m > 30);
  expect(away).toEqual([]);
}, 60_000);

test("QC on another thread gives the cells QC here does", async () => {
  // 1 Hz at 6 kn: spikes, a stretch where the sounder lost the bottom, and a stuck run.
  // A verdict depends on how far ahead QC sees, so each comes back before the next
  // sounding, as QC here judges.
  const data = Array.from({ length: 3000 }, (_, i) => ({
    latitude: 36.98 + (i * 3) / 110540,
    longitude: -76.2 + Math.sin(i / 50) * 0.0005,
    depth:
      i % 97 === 0
        ? 1
        : i >= 800 && i < 900
          ? 60 + (i % 30)
          : i >= 1500 && i < 1900
            ? 12
            : 6 + (i % 5) * 0.1,
    timestamp: start.add({ seconds: i }),
  }));
  const build = async (threaded: boolean) => {
    const store = createCellStore(createDB(":memory:"));
    const writer = createCellWriter(store, {
      flushIntervalMs: 100_000,
      qc: threaded
        ? (soundings, arrival) =>
            Promise.resolve(trackQC(soundings, arrival, DEFINITIONS.qc))
        : undefined,
    });
    for (const d of data) {
      writer.write(d, () => {});
      await new Promise((r) => setImmediate(r));
    }
    await end(writer);
    return [
      store.cells(-76.3, 36, -76.1, 37.1),
      store.shoals(-76.3, 36, -76.1, 37.1),
    ];
  };
  const here = await build(false);
  expect(here[0].length).toBeGreaterThan(100);
  expect(here[1].length).toBeGreaterThan(10);
  expect(await build(true)).toEqual(here);
}, 30_000);
