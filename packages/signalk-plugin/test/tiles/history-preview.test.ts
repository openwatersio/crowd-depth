import { ObservationDataError } from "../../src/observations/errors.js";
import { expect, test, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

vi.mock("node:timers/promises", async (original) => {
  const actual = await original<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});
import { Readable } from "node:stream";
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../../src/storage.js";
import {
  createPreviewStore,
  observation,
  scanPreview,
} from "../../src/tiles/history-preview.js";
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

test("draws local viewport history before querying external track discovery", async () => {
  const db = createDB(":memory:");
  const store = createPreviewStore(db, "local-first");
  const order: string[] = [];
  const frame = (hours: number) =>
    new Timeframe(
      Temporal.Instant.fromEpochMilliseconds(t - hours * hour),
      Temporal.Instant.fromEpochMilliseconds(t - (hours - 1) * hour),
    );
  const source: BathymetrySource = {
    createReader: ({ from }) => {
      order.push(String(from.epochMilliseconds));
      return Readable.from([sample(from.epochMilliseconds)]);
    },
    getStoredTimeframes: () => [frame(10)],
    getPreviewTimeframes: async () => {
      order.push("external");
      return [frame(20)];
    },
    getAvailableTimeframes: () => [],
  };
  try {
    await scanPreview({
      source,
      store,
      config,
      signal: new AbortController().signal,
      until: t,
      since: t - 24 * hour,
      view: () => view,
    });
    expect(order.slice(0, 4)).toEqual([
      String(t - hour),
      String(t - 10 * hour),
      "external",
      String(t - 20 * hour),
    ]);
  } finally {
    db.close();
  }
});

test("a corrupt owned window does not prevent later preview windows or discovery", async () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "corrupt-owned");
  const seen: number[] = [],
    errors: unknown[] = [];
  let discovered = false;
  const frame = (h: number) =>
    new Timeframe(
      Temporal.Instant.fromEpochMilliseconds(t - h * hour),
      Temporal.Instant.fromEpochMilliseconds(t - (h - 1) * hour),
    );
  const source: BathymetrySource = {
    createReader: ({ from }) => {
      seen.push(from.epochMilliseconds);
      if (from.epochMilliseconds === t - 10 * hour)
        throw new ObservationDataError("Observation chunk checksum mismatch");
      return Readable.from([sample(from.epochMilliseconds)]);
    },
    getStoredTimeframes: () => [frame(10), frame(11)],
    getAvailableTimeframes: () => {
      discovered = true;
      return [];
    },
  };
  try {
    await scanPreview({
      source,
      store,
      config,
      signal: new AbortController().signal,
      until: t,
      since: t - 24 * hour,
      view: () => view,
      onError: (e) => errors.push(e),
    });
    expect(seen).toContain(t - 11 * hour);
    expect(discovered).toBe(true);
    expect(errors).toHaveLength(1);
    expect(store.done("history", t - 10 * hour, t - 9 * hour)).toBe(false);
    expect(store.done("history", t - 24 * hour, t)).toBe(false);
  } finally {
    db.close();
  }
});

test.each([
  [1, "checksum mismatch"],
  [10, "checksum mismatch"],
  [10, "Reconciled import exceeds sample limit"],
] as const)(
  "a permanent error %s hours ago (%s) cannot pin temporal discovery or complete its span",
  async (badHour, message) => {
    const db = createDB(":memory:"),
      store = createPreviewStore(db, "temporal-hole");
    const seen: number[] = [];
    let corrupt = true;
    const windows = [badHour, 11, 30].map(
      (h) =>
        new Timeframe(
          Temporal.Instant.fromEpochMilliseconds(t - h * hour),
          Temporal.Instant.fromEpochMilliseconds(t - (h - 1) * hour),
        ),
    );
    const source: BathymetrySource = {
      createReader: ({ from }) => {
        seen.push(from.epochMilliseconds);
        if (corrupt && from.epochMilliseconds === t - badHour * hour)
          throw new ObservationDataError(message);
        return Readable.from([sample(from.epochMilliseconds)]);
      },
      getAvailableTimeframes: (span) =>
        windows.filter(
          (w) =>
            w.from.epochMilliseconds >= span.from.epochMilliseconds &&
            w.to.epochMilliseconds <= span.to.epochMilliseconds,
        ),
    };
    const options = {
      source,
      store,
      config,
      signal: new AbortController().signal,
      until: t,
      since: t - 48 * hour,
    };
    try {
      await scanPreview(options);
      expect(seen).toContain(t - 30 * hour);
      expect(
        store.done("history", t - badHour * hour, t - (badHour - 1) * hour),
      ).toBe(false);
      expect(store.done("history", t - 24 * hour, t)).toBe(false);
      expect(store.done("history", t - 48 * hour, t - 24 * hour)).toBe(true);
      corrupt = false;
      await scanPreview(options);
      expect(store.done("history", t - 24 * hour, t)).toBe(true);
    } finally {
      db.close();
    }
  },
);

test("paints successive sparse stored pages before external discovery", async () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "paged-local");
  const order: string[] = [];
  const frame = (h: number) =>
    new Timeframe(
      Temporal.Instant.fromEpochMilliseconds(t - h * hour),
      Temporal.Instant.fromEpochMilliseconds(t - (h - 1) * hour),
    );
  const source: BathymetrySource = {
    createReader: ({ from }) => {
      order.push(String(from.epochMilliseconds));
      return Readable.from([sample(from.epochMilliseconds)]);
    },
    getStoredTimeframePage: (_span, _bounds, before) =>
      before === undefined
        ? { windows: [frame(10)], before: 123 }
        : { windows: [frame(11)] },
    getPreviewTimeframes: async () => {
      order.push("external");
      return [];
    },
    getAvailableTimeframes: () => [],
  };
  try {
    await scanPreview({
      source,
      store,
      config,
      signal: new AbortController().signal,
      until: t,
      since: t - 24 * hour,
      view: () => view,
    });
    expect(order.slice(0, 4)).toEqual([
      String(t - hour),
      String(t - 10 * hour),
      String(t - 11 * hour),
      "external",
    ]);
  } finally {
    db.close();
  }
});

test.each(["newest", "viewport", "temporal"])(
  "retries transient %s preview failures in the same run",
  async (path) => {
    const db = createDB(":memory:"),
      store = createPreviewStore(db, "transient");
    const target = path === "newest" ? t - hour : t - 10 * hour;
    const window = new Timeframe(
      Temporal.Instant.fromEpochMilliseconds(target),
      Temporal.Instant.fromEpochMilliseconds(target + hour),
    );
    let attempts = 0;
    const errors: unknown[] = [];
    vi.mocked(sleep).mockResolvedValue(undefined);
    try {
      await scanPreview({
        source: {
          createReader: ({ from }) => {
            if (from.epochMilliseconds === target && ++attempts === 1)
              throw new Error("Observation provider request still pending");
            return Readable.from([sample(from.epochMilliseconds)]);
          },
          ...(path === "viewport"
            ? { getStoredTimeframes: () => [window] }
            : {}),
          getAvailableTimeframes: () => (path === "temporal" ? [window] : []),
        },
        store,
        config,
        signal: new AbortController().signal,
        until: t,
        since: t - 24 * hour,
        view: () => view,
        onError: (error) => errors.push(error),
      });
      expect(attempts).toBe(2);
      expect(errors).toHaveLength(1);
      expect(store.done("history", target, target + hour)).toBe(true);
    } finally {
      vi.mocked(sleep).mockReset();
      vi.mocked(sleep).mockImplementation(async (ms, value, options) => {
        const actual = await vi.importActual<
          typeof import("node:timers/promises")
        >("node:timers/promises");
        return actual.setTimeout(ms, value, options);
      });
      db.close();
    }
  },
);

test.each(["on-error", "during-wait"])(
  "a failed viewport yields after panning %s",
  async (when) => {
    const db = createDB(":memory:"),
      store = createPreviewStore(db, "pan-failure");
    let current = view as readonly [number, number, number, number, number];
    const seen: number[] = [];
    const frame = (h: number) =>
      new Timeframe(
        Temporal.Instant.fromEpochMilliseconds(t - h * hour),
        Temporal.Instant.fromEpochMilliseconds(t - (h - 1) * hour),
      );
    if (when === "during-wait")
      vi.mocked(sleep).mockImplementationOnce(async () => {
        current = [14, -82, 25, -80, 27];
      });
    try {
      await scanPreview({
        source: {
          createReader: ({ from }) => {
            seen.push(from.epochMilliseconds);
            if (from.epochMilliseconds === t - 10 * hour)
              throw Error("temporary provider outage");
            return Readable.from([sample(from.epochMilliseconds)]);
          },
          getStoredTimeframes: () => [current === view ? frame(10) : frame(11)],
          getAvailableTimeframes: () => [],
        },
        store,
        config,
        until: t,
        since: t - 24 * hour,
        signal: new AbortController().signal,
        view: () => current,
        onError: () => {
          if (when === "on-error") current = [14, -82, 25, -80, 27];
        },
      });
      expect(seen.filter((time) => time === t - 10 * hour)).toHaveLength(1);
      expect(seen).toContain(t - 11 * hour);
      expect(store.done("history", t - 10 * hour, t - 9 * hour)).toBe(false);
      expect(store.done("history", t - 24 * hour, t)).toBe(false);
    } finally {
      vi.mocked(sleep).mockReset();
      db.close();
    }
  },
);

test("owned preview pages are painted before empty provider coverage is completed", async () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "owned-pages");
  const from = t - 10 * hour;
  const pages: (number | undefined)[] = [];
  const source: BathymetrySource = {
    createReader: (window) =>
      Readable.from(
        window.from.epochMilliseconds === from ? [sample(from)] : [],
      ),
    getAvailableTimeframes: () => [],
    getStoredTimeframePage: (_span, _bounds, before) => {
      pages.push(before);
      return before === undefined
        ? { windows: [], before: 5 }
        : {
            windows: [
              new Timeframe(
                Temporal.Instant.fromEpochMilliseconds(from),
                Temporal.Instant.fromEpochMilliseconds(from + hour),
              ),
            ],
          };
    },
  };
  try {
    await scanPreview({
      source,
      store,
      config,
      signal: new AbortController().signal,
      until: t,
      since: t - 24 * hour,
    });
    expect(pages).toEqual([undefined, 5]);
    expect(store.features(view, 0).map((f) => f.properties.time)).toContain(
      from,
    );
    expect(store.done("history", t - 24 * hour, t)).toBe(true);
    const reopened = createPreviewStore(db, "owned-pages");
    expect(reopened.features(view, 0).map((f) => f.properties.time)).toContain(
      from,
    );
  } finally {
    db.close();
  }
});

test("invalidates provider-only coverage on upgrade while retaining visible points", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "coverage-upgrade");
  try {
    store.write("history", [point(t - 1000)], [t - hour, t]);
    store.write("local", [], [t - hour, t]);
    // A rollback writes old provider-only coverage into the same database.
    db.prepare(
      "UPDATE preview_windows SET source='history' WHERE source='history:v2'",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO preview_meta VALUES('history_coverage_version','2')",
    ).run();
    const upgraded = createPreviewStore(db, "coverage-upgrade");
    expect(upgraded.done("history", t - hour, t)).toBe(false);
    expect(upgraded.done("local", t - hour, t)).toBe(true);
    expect(upgraded.features(view, 0)).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("distant failed windows leave healthy intervening history complete", async () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "separate-holes");
  const broken = [t - 50 * hour, t - 10 * hour];
  const window = (start: number) =>
    new Timeframe(
      Temporal.Instant.fromEpochMilliseconds(start),
      Temporal.Instant.fromEpochMilliseconds(start + hour),
    );
  const source: BathymetrySource = {
    createReader: ({ from }) => {
      if (broken.includes(from.epochMilliseconds))
        throw new ObservationDataError("damaged original");
      return Readable.from([]);
    },
    getStoredTimeframes: () => broken.map(window),
    getAvailableTimeframes: ({ from, to }) =>
      broken
        .filter((t) => t >= from.epochMilliseconds && t < to.epochMilliseconds)
        .map(window),
  };
  try {
    await scanPreview({
      source,
      store,
      config,
      signal: new AbortController().signal,
      until: t,
      since: t - 72 * hour,
      view: () => view,
    });
    for (const start of broken)
      expect(store.done("history", start, start + hour)).toBe(false);
    expect(store.done("history", t - 48 * hour, t - 24 * hour)).toBe(true);
    expect(store.done("history", t - 9 * hour, t)).toBe(true);
  } finally {
    db.close();
  }
});
