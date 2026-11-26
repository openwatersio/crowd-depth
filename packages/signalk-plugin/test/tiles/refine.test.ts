import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createObservationStore } from "../../dist/observations/client.js";
import { storedHistorySource } from "../../src/observations/source.js";
import { expect, test, vi } from "vitest";
import { Readable } from "node:stream";
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../../src/storage.js";
import { createCellStore } from "../../src/tiles/cells.js";
import { cellAt } from "../../src/tiles/geometry.js";
import { refineHistory } from "../../src/tiles/refine.js";
import { getPendingBackfill } from "../../src/tiles/backfill.js";
import { Timeframe, type BathymetrySource } from "../../src/types.js";
import { config } from "../helper.js";

const at = Temporal.Instant.from("2026-10-01T00:00Z");
const HOUR = 3600_000;
const ms = at.epochMilliseconds;
const position = cellAt(-80, 26);
const cells = (store: ReturnType<typeof createCellStore>) =>
  store.cells(-80.001, 25.999, -79.999, 26.001);
const pass = (depth: number, hour: number) => ({
  ...position,
  depth,
  day: Math.floor(ms / 86400000),
  time: (ms + hour * HOUR) * 1000,
});

test("independent jobs produce identical EMA in any discovery order and replacement retracts old values", () => {
  const db = createDB(":memory:"),
    other = createDB(":memory:");
  const forward = createCellStore(db),
    reverse = createCellStore(other);
  try {
    for (const i of [0, 1, 2])
      forward.replaceWindow(
        ms + i * HOUR,
        ms + (i + 1) * HOUR,
        [pass([5, 10, 3][i], i)],
        [],
      );
    for (const i of [2, 1, 0])
      reverse.replaceWindow(
        ms + i * HOUR,
        ms + (i + 1) * HOUR,
        [pass([5, 10, 3][i], i)],
        [],
      );
    expect(cells(reverse)).toEqual(cells(forward));
    reverse.replaceWindow(ms + HOUR, ms + 2 * HOUR, [pass(10, 1)], []);
    expect(cells(reverse)).toEqual(cells(forward));
    reverse.replaceWindow(ms + HOUR, ms + 2 * HOUR, [], []);
    expect(cells(reverse)[0].passes).toBe(2);
    reverse.replaceWindow(ms, ms + HOUR, [], []);
    reverse.replaceWindow(ms + 2 * HOUR, ms + 3 * HOUR, [], []);
    expect(cells(reverse)).toEqual([]);
    expect(reverse.cells(-80.01, 25.99, -79.99, 26.01, 6)).toEqual([]);
  } finally {
    db.close();
    other.close();
  }
});

test("replacing a job retracts rejected shoals and fails atomically", () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  try {
    store.replaceWindow(
      ms,
      ms + HOUR,
      [pass(5, 0)],
      [{ lon: -80, lat: 26, depth: 1, time: ms * 1000 }],
    );
    const before = cells(store);
    expect(() =>
      store.replaceWindow(
        ms,
        ms + HOUR,
        [{ ...position, depth: 7, day: 1 }],
        [],
      ),
    ).toThrow("timestamp");
    expect(cells(store)).toEqual(before);
    expect(store.shoals(-81, 25, -79, 27)).toHaveLength(1);
    store.replaceWindow(ms, ms + HOUR, [pass(6, 0)], []);
    expect(store.shoals(-81, 25, -79, 27)).toEqual([]);
  } finally {
    db.close();
  }
});

test("recent history publishes before older discovery and retries skip committed jobs", async () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  store.setMeta("backfill", `${at}/${at.add({ hours: 3 })}`);
  const commits: number[] = [];
  let fail = true;
  const source: BathymetrySource = {
    createReader: (window) =>
      Readable.from(
        Array.from({ length: window.duration.total("hours") * 60 }, (_, i) => ({
          longitude: -80,
          latitude: 26,
          depth: 5 + (i % 3) * 0.01,
          timestamp: window.from.add({ seconds: i * 60 }),
        })),
      ),
    getAvailableTimeframes: () => {
      expect(commits).toContain(ms + 2 * HOUR);
      if (fail) throw new Error("discovery unavailable");
      return [0, 1, 2].map(
        (i) => new Timeframe(at.add({ hours: i }), at.add({ hours: i + 1 })),
      );
    },
  };
  const run = () =>
    refineHistory({
      source,
      store,
      config,
      signal: new AbortController().signal,
      onChange: () => {
        const rows = db
          .prepare("SELECT start FROM refined_windows ORDER BY start")
          .all();
        commits.push(...rows.map((r) => r.start as number));
      },
    });
  try {
    await expect(run()).rejects.toThrow("discovery unavailable");
    expect(cells(store).length).toBeGreaterThan(0);
    expect(getPendingBackfill(store)).toBeDefined();
    fail = false;
    await run();
    expect(getPendingBackfill(store)).toBeUndefined();
    expect(db.prepare("SELECT count(*) n FROM refined_windows").get()).toEqual({
      n: 3,
    });
    const once = cells(store);
    store.setMeta("backfill", `${at}/${at.add({ hours: 3 })}`);
    await run();
    expect(cells(store)).toEqual(once);
  } finally {
    db.close();
  }
});

test("a failed hour publishes no incomplete contribution or coverage receipt", async () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  store.setMeta("backfill", `${at}/${at.add({ hours: 1 })}`);
  const source: BathymetrySource = {
    getAvailableTimeframes: () => [],
    createReader: () =>
      Readable.from(
        (async function* () {
          for (let i = 0; i < 2500; i++)
            yield {
              longitude: -80 + i / 10000,
              latitude: 26,
              depth: 5 + (i % 3) * 0.1,
              timestamp: at.add({ seconds: i }),
            };
          throw new Error("interrupted");
        })(),
      ),
  };
  try {
    await expect(
      refineHistory({
        source,
        store,
        config,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("remain pending");
    expect(db.prepare("SELECT count(*) n FROM cells").get()).toEqual({ n: 0 });
    expect(store.windowDone(ms, ms + HOUR)).toBe(false);
  } finally {
    db.close();
  }
});

test("an extended tail replaces its earlier partial-hour contribution", () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  try {
    store.replaceWindow(ms, ms + 1000, [pass(3, 0)], []);
    store.replaceWindow(ms, ms + HOUR, [pass(4, 0)], []);
    expect(cells(store)[0]).toMatchObject({ passes: 1, m: 4 });
    expect(store.windowDone(ms, ms + 1000)).toBe(false);
    expect(store.windowDone(ms, ms + HOUR)).toBe(true);
  } finally {
    db.close();
  }
});

test("stationary sample rate cannot increase an hour's total recency weight", () => {
  const a = createDB(":memory:"),
    b = createDB(":memory:");
  const first = createCellStore(a),
    second = createCellStore(b);
  try {
    first.replaceWindow(ms, ms + HOUR, [pass(4, 0)], []);
    second.replaceWindow(
      ms,
      ms + HOUR,
      Array.from({ length: 60 }, (_, i) => ({
        ...pass(4, 0),
        time: ms * 1000 + i * 1000000,
      })),
      [],
    );
    for (const store of [first, second])
      store.replaceWindow(ms + HOUR, ms + 2 * HOUR, [pass(8, 1)], []);
    expect(cells(second)[0].m).toBe(cells(first)[0].m);
    expect(cells(second)[0].d).toBe(cells(first)[0].d);
    expect(cells(second)[0].passes).toBe(61);
  } finally {
    a.close();
    b.close();
  }
});

test("empty or partial provider data cannot erase a live cell in its hour", () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  try {
    store.addPasses([pass(4, 0.25)]);
    store.replaceWindow(ms, ms + HOUR, [], []);
    expect(cells(store)[0]).toMatchObject({ m: 4, passes: 1 });
    store.replaceWindow(ms, ms + HOUR, [pass(9, 0.75)], []);
    expect(cells(store)[0]).toMatchObject({ m: 4, passes: 1 });
  } finally {
    db.close();
  }
});

test("one failed recent window does not block independent older windows", async () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  const to = at.add({ hours: 6 });
  store.setMeta("backfill", `${at}/${to}`);
  const source: BathymetrySource = {
    getAvailableTimeframes: () =>
      Array.from(
        { length: 6 },
        (_, i) => new Timeframe(at.add({ hours: i }), at.add({ hours: i + 1 })),
      ),
    createReader: (window) => {
      if (window.from.epochMilliseconds === ms + 5 * HOUR)
        throw new Error("one broken hour");
      return Readable.from([
        { longitude: -80, latitude: 26, depth: 5, timestamp: window.from },
      ]);
    },
  };
  try {
    await expect(
      refineHistory({
        source,
        store,
        config,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("remain pending");
    expect(store.windowDone(ms, ms + HOUR)).toBe(true);
    expect(store.windowDone(ms + 5 * HOUR, ms + 6 * HOUR)).toBe(false);
    expect(cells(store).length).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});

test("successful empty paired history is receipted without deleting live evidence", async () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  store.setMeta("backfill", `${at}/${at.add({ hours: 1 })}`);
  store.addPasses([pass(4, 0.5)]);
  try {
    await refineHistory({
      store,
      config,
      signal: new AbortController().signal,
      source: {
        getAvailableTimeframes: () => [new Timeframe(at, at.add({ hours: 1 }))],
        createReader: () => undefined,
      },
    });
    expect(getPendingBackfill(store)).toBeUndefined();
    expect(store.windowDone(ms, ms + HOUR)).toBe(true);
    expect(cells(store)[0]).toMatchObject({ m: 4, passes: 1 });
  } finally {
    db.close();
  }
});

test("an extended hour preserves imported evidence that predates a live pass", () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  try {
    store.replaceWindow(ms, ms + 20 * 60000, [pass(4, 0.1)], []);
    store.addPasses([pass(8, 0.7)]);
    const before = cells(store);
    store.replaceWindow(ms, ms + 50 * 60000, [pass(4, 0.1), pass(8, 0.7)], []);
    expect(cells(store)).toEqual(before);
    store.replaceWindow(ms, ms + HOUR, [pass(4, 0.1), pass(8, 0.7)], []);
    expect(cells(store)).toEqual(before);
  } finally {
    db.close();
  }
});

test("visible legacy previews refine without discovery or advancing global coverage", async () => {
  const { createPreviewStore } =
    await import("../../src/tiles/history-preview.js");
  const { refineVisible } = await import("../../src/tiles/refine.js");
  const db = createDB(":memory:"),
    store = createCellStore(db);
  const preview = createPreviewStore(db, "legacy-preview");
  const controller = new AbortController();
  const pending = `${at.subtract({ hours: 500 })}/${at.add({ hours: 500 })}`;
  store.setMeta("backfill", pending);
  store.completeEmptyWindow(ms, ms + HOUR);
  preview.write("history", [{ lon: -80, lat: 26, depth: 5, time: ms + 60000 }]);
  const view = [14, -80.01, 25.99, -79.99, 26.01] as const;
  let discovery = 0;
  const busy: boolean[] = [];
  try {
    await refineVisible({
      onBusy: (value) => busy.push(value),
      store,
      config,
      signal: controller.signal,
      availableThrough: at.add({ hours: 2 }),
      timestamps: () => preview.features(view, 0).map((f) => f.properties.time),
      source: {
        getAvailableTimeframes: () => {
          discovery++;
          throw new Error("discovery unavailable");
        },
        createReader: (window) =>
          Readable.from([
            {
              longitude: -80,
              latitude: 26,
              depth: 5,
              timestamp: window.from.add({ minutes: 1 }),
            },
          ]),
      },
      onChange: () => controller.abort(),
    });
    expect(discovery).toBe(0);
    expect(busy).toEqual([true, false]);
    expect(store.getMeta("backfill")).toBe(pending);
    expect(store.windowDone(ms, ms + HOUR, false)).toBe(true);
    expect(cells(store).length).toBeGreaterThan(0);
    expect(preview.features(view, 0)).toEqual([]);
  } finally {
    controller.abort();
    db.close();
  }
});

test("sparse history discovery expands and a failed large query shrinks the next retry", async () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  const begin = at.subtract({ hours: 365 * 24 });
  const pending = `${begin}/${at}`;
  let fail = true;
  const spans: number[] = [];
  const source: BathymetrySource = {
    createReader: () => undefined,
    getAvailableTimeframes: (w) => {
      const days = w.duration.total("hours") / 24;
      spans.push(days);
      if (fail && days >= 8) throw new Error("slow large query");
      return [];
    },
  };
  const run = () =>
    refineHistory({
      source,
      store,
      config,
      signal: new AbortController().signal,
    });
  try {
    store.setMeta("backfill", pending);
    await expect(run()).rejects.toThrow("slow large query");
    expect(spans.slice(0, 4)).toEqual([1, 2, 4, 8]);
    expect(store.getMeta("refine_availability_days")).toBe("4");
    fail = false;
    spans.length = 0;
    await run();
    expect(Math.max(...spans)).toBe(4);
    expect(spans.length).toBeLessThan(100);
    store.setMeta("refine_availability_days", "365");
    store.setMeta("backfill", pending);
    spans.length = 0;
    await run();
    expect(spans.length).toBeLessThan(12);
  } finally {
    db.close();
  }
});

test("viewport paging advances past completed windows across discovery retries", async () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  store.setMeta("backfill", `${at}/${at.add({ hours: 100 })}`);
  store.completeEmptyWindow(ms + 90 * HOUR, ms + 91 * HOUR);
  const cursors: (number | undefined)[] = [];
  const source: BathymetrySource = {
    createReader: () => Readable.from([]),
    getAvailableTimeframes: () => {
      throw Error("offline availability");
    },
    getStoredTimeframePage: (_span, _bounds, before) => {
      cursors.push(before);
      return before === undefined
        ? {
            windows: [
              new Timeframe(at.add({ hours: 90 }), at.add({ hours: 91 })),
            ],
            before: 123,
          }
        : { windows: [new Timeframe(at, at.add({ hours: 1 }))] };
    },
  };
  try {
    const run = () =>
      refineHistory({
        store,
        source,
        config,
        signal: new AbortController().signal,
        view: () => [14, -81, 25, -79, 27],
      });
    await expect(run()).rejects.toThrow("offline availability");
    expect(store.windowDone(ms, ms + HOUR)).toBe(false);
    await expect(run()).rejects.toThrow("offline availability");
    expect(cursors).toEqual([undefined, 123]);
    expect(store.windowDone(ms, ms + HOUR)).toBe(true);
  } finally {
    db.close();
  }
});

test("empty provider availability does not clear backfill before all owned pages are consumed", async () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  store.setMeta("backfill", `${at}/${at.add({ hours: 100 })}`);
  store.completeEmptyWindow(ms + 90 * HOUR, ms + 91 * HOUR);
  const globalCursors: (number | undefined)[] = [];
  const source: BathymetrySource = {
    createReader: () => Readable.from([]),
    getAvailableTimeframes: () => [],
    getStoredTimeframePage: (_span, bounds, before) => {
      if (bounds[0] === -180) globalCursors.push(before);
      return before === undefined
        ? {
            windows: [
              new Timeframe(at.add({ hours: 90 }), at.add({ hours: 91 })),
            ],
            before: 123,
          }
        : { windows: [new Timeframe(at, at.add({ hours: 1 }))] };
    },
  };
  try {
    await refineHistory({
      store,
      source,
      config,
      signal: new AbortController().signal,
      view: () => [14, -81, 25, -79, 27],
    });
    expect(globalCursors).toEqual([undefined, 123]);
    expect(store.windowDone(ms, ms + HOUR)).toBe(true);
    expect(getPendingBackfill(store)).toBeUndefined();
  } finally {
    db.close();
  }
});

test("retains unattempted viewport hints when processing fails mid-page", async () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  store.setMeta("backfill", `${at}/${at.add({ hours: 100 })}`);
  store.completeEmptyWindow(ms + 99 * HOUR, ms + 100 * HOUR);
  let pages = 0;
  const source: BathymetrySource = {
    createReader: ({ from }) => {
      if (from.epochMilliseconds < ms + 59 * HOUR) throw Error("provider bad");
      return Readable.from([]);
    },
    getAvailableTimeframes: () => {
      throw Error("discovery offline");
    },
    getStoredTimeframePage: () => {
      pages++;
      return {
        windows: [10, 20, 30, 40, 50, 60, 70].map(
          (h) => new Timeframe(at.add({ hours: h }), at.add({ hours: h + 1 })),
        ),
        before: 42,
      };
    },
  };
  try {
    const run = () =>
      refineHistory({
        store,
        source,
        config,
        signal: new AbortController().signal,
        view: () => [14, -81, 25, -79, 27],
      });
    await expect(run()).rejects.toThrow("provider bad");
    await expect(run()).rejects.toThrow("discovery offline");
    expect(pages).toBe(1);
    expect(store.windowDone(ms + 60 * HOUR, ms + 61 * HOUR)).toBe(true);
    expect(store.windowDone(ms + 70 * HOUR, ms + 71 * HOUR)).toBe(true);
    expect(store.windowDone(ms + 50 * HOUR, ms + 51 * HOUR)).toBe(false);
  } finally {
    db.close();
  }
});

test.each([false, true])(
  "refines nonaligned owned history once with provider availability=%s",
  async (available) => {
    const dir = mkdtempSync(join(tmpdir(), "refine-owned-alias-"));
    const archive = createObservationStore(join(dir, "observations.sqlite"));
    const db = createDB(":memory:"),
      store = createCellStore(db);
    let pruned = false;
    const points = Array.from({ length: 31 }, (_, i) => ({
      timestamp: at.add({ minutes: 40, seconds: i }).toString(),
      longitude: -80,
      latitude: 26,
      depth: 4 + (i % 3) * 0.01,
      depthSource: "d",
      positionSource: "g",
    }));
    const source = storedHistorySource(
      archive,
      {
        createReader: () => {
          throw Error("corrected upstream reader should not be called");
        },
        createObservationReader: () => Readable.from(pruned ? [] : points),
        createObservationPreviewReader: () => Readable.from(points),
        getAvailableTimeframes: () =>
          available ? [new Timeframe(at, at.add({ hours: 1 }))] : [],
      },
      config,
      new AbortController().signal,
    );
    try {
      await (await source.createPreviewReader!(
        new Timeframe(
          at.add({ minutes: 23 }),
          at.add({ hours: 1, minutes: 23 }),
        ),
      ))!.toArray();
      pruned = true;
      store.setMeta("backfill", `${at}/${at.add({ hours: 2 })}`);
      await refineHistory({
        source,
        store,
        config,
        signal: new AbortController().signal,
      });
      expect(cells(store).length).toBeGreaterThan(0);
      expect(store.windowDone(ms, ms + HOUR)).toBe(true);
      expect(store.windowDone(ms + 23 * 60_000, ms + HOUR)).toBe(false);
      const jobs = db
        .prepare(
          "SELECT DISTINCT job FROM cell_passes WHERE job LIKE 'window:%'",
        )
        .all();
      expect(jobs).toEqual([{ job: `window:${ms}` }]);
      const before = db
        .prepare("SELECT * FROM cell_passes ORDER BY job,ordinal")
        .all();
      await refineHistory({
        source,
        store,
        config,
        signal: new AbortController().signal,
        windows: [
          new Timeframe(
            at.add({ minutes: 23 }),
            at.add({ hours: 1, minutes: 23 }),
          ),
        ],
      });
      expect(
        db.prepare("SELECT * FROM cell_passes ORDER BY job,ordinal").all(),
      ).toEqual(before);
      expect(getPendingBackfill(store)).toBeUndefined();
    } finally {
      db.close();
      await archive.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("segmented history may complete a healthy hour beyond the single-request deadline", async () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  const controller = new AbortController();
  let yielded = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const source: BathymetrySource = {
      observationRequestMilliseconds: 300000,
      createReader: ({ from }) =>
        Readable.from(
          (async function* () {
            for (let i = 0; i < 12; i++) {
              await vi.advanceTimersByTimeAsync(3000);
              yielded++;
              yield {
                timestamp: from.add({ minutes: i * 5 }),
                longitude: -80,
                latitude: 26,
                depth: 5,
              };
            }
          })(),
        ),
      getAvailableTimeframes: () => [],
    };
    await refineHistory({
      source,
      store,
      config,
      signal: controller.signal,
      windows: [new Timeframe(at, at.add({ hours: 1 }))],
    });
    expect(yielded).toBe(36);
    expect(store.windowDone(ms, ms + HOUR)).toBe(true);
  } finally {
    controller.abort();
    vi.useRealTimers();
    db.close();
  }
});

test("a late shorter refinement cannot retract an extended window", () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  try {
    const earlier = pass(4, 0);
    const later = {
      ...pass(8, 0),
      py: position.py + 1,
      time: (ms + 50 * 60000) * 1000,
    };
    store.replaceWindow(ms, ms + HOUR, [earlier, later], []);
    const before = cells(store);
    expect(
      store.replaceWindow(ms, ms + HOUR / 2, [{ ...earlier, depth: 3 }], []),
    ).toEqual([]);
    expect(cells(store)).toEqual(before);
    expect(store.windowDone(ms, ms + HOUR)).toBe(true);
    expect(store.windowDone(ms, ms + HOUR / 2)).toBe(false);
    store.completeEmptyWindow(ms, ms + HOUR / 2);
    expect(
      db.prepare("SELECT count(*) n FROM refined_empty_windows").get(),
    ).toEqual({ n: 0 });
    expect(cells(store)).toEqual(before);
  } finally {
    db.close();
  }
});

test("superseded partial windows skip acquisition and visible worker scheduling", async () => {
  const { refineVisible } = await import("../../src/tiles/refine.js");
  const db = createDB(":memory:"),
    store = createCellStore(db);
  const read = vi.fn(() => undefined);
  const source: BathymetrySource = {
    createReader: read,
    getAvailableTimeframes: () => [],
  };
  const end = at.add({ minutes: 30 });
  try {
    store.replaceWindow(ms, ms + HOUR, [pass(4, 0)], []);
    await refineHistory({
      source,
      store,
      config,
      availableThrough: end,
      windows: [new Timeframe(at, end)],
      signal: new AbortController().signal,
    });
    expect(read).not.toHaveBeenCalled();
    const abort = new AbortController(),
      onBusy = vi.fn();
    const visible = refineVisible({
      source,
      store,
      config,
      availableThrough: end,
      signal: abort.signal,
      timestamps: () => [ms + 1],
      onBusy,
    });
    abort.abort();
    await visible;
    expect(onBusy).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
