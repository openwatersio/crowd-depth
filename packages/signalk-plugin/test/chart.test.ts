import { expect, test, vi } from "vitest";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { app, config } from "./helper.js";
import { Config, History, historySpan } from "../src/config.js";
import {
  cellConfig,
  ownStyle,
  startChart,
  startChartSafely,
} from "../src/chart.js";
import { createDB } from "../src/storage.js";
import { createSqliteSource } from "../src/sources/sqlite.js";
import { BathymetrySource, Timeframe } from "../src/types.js";
import { correctForSensorPosition } from "../src/streams/index.js";
import {
  CellStore,
  addPendingBackfill,
  backfillCells,
  createCellStore,
  createCellWriter,
  getPendingBackfill,
  getThrough,
  registerLayerRoutes,
  recordBackfillFailure,
  startRebuild,
} from "../src/tiles/index.js";

/** The cell holding a position, if the store has one. */
const cellAt = (store: CellStore, lon: number, lat: number) =>
  store.cells(lon - 1e-7, lat - 1e-7, lon + 1e-7, lat + 1e-7)[0];

/** GNSS antenna 4 m aft of the transducer and 1 m to port of it. */
const offsetConfig: Config = {
  ...config,
  path: "belowTransducer",
  sounder: { x: 0, y: 2, z: 0.5 },
  gnss: { x: -1, y: 6, z: 2 },
};

const at = (s: string) => Temporal.Instant.from(s);

test("the layer's own style falls back to the default for hand-edited values", () => {
  const chart = {
    color: "#FFF",
    shoalColor: "#00A0A0",
    tint: "toString",
    contours: "false",
  };
  expect(ownStyle({ ...config, chart } as unknown as Config)).toEqual({
    accent: "#7b2cbf",
    shoal: "#00A0A0",
    tint: "normal",
    contours: true,
  });
});

test("backfills the tiles from the plugin's source with its correction", async () => {
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  const soundings = [
    {
      latitude: 47.6,
      longitude: -122.3,
      depth: 4.2,
      timestamp: at("2026-10-16T09:00:00Z"),
      heading: 0,
    },
    // No heading and an offset: the plugin drops it, so the tiles must too.
    {
      latitude: 47.7,
      longitude: -122.4,
      depth: 1,
      timestamp: at("2026-10-16T09:00:10Z"),
    },
  ];
  await pipeline(Readable.from(soundings), source.createWriter!());

  const store = createCellStore(db);
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"), historySpan(config));
  await backfillCells({
    app,
    config: offsetConfig,
    source,
    store,
    signal: new AbortController().signal,
  });

  const corrected = correctForSensorPosition(offsetConfig)(soundings[0])!;
  const cell = cellAt(store, corrected.longitude, corrected.latitude)!;
  expect(cell.m).toBe(4.2);
  expect(cell.passes).toBe(1);

  expect(cellAt(store, -122.4, 47.7)).toBeUndefined();
  // Done: nothing is left to backfill, and the marker is at the span's end.
  expect(getPendingBackfill(store)).toBeUndefined();
  expect(getThrough(store)?.toString()).toBe("2026-10-16T12:00:00Z");
});

test("backfill starts where the tiles left off", async () => {
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(
    Readable.from([
      {
        latitude: 0,
        longitude: 0,
        depth: 3,
        timestamp: at("2026-10-16T08:00:00Z"),
        heading: 0,
      },
    ]),
    source.createWriter!(),
  );
  const store = createCellStore(db);
  store.setMeta("through", "2026-10-16T09:00:00Z");
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"), historySpan(config));

  await backfillCells({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
  });

  expect(cellAt(store, 0, 0)).toBeUndefined();
});

test("the chart tables migrate onto an existing database", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
  try {
    const file = join(dir, "bathymetry.sqlite");
    // A database at the schema before the chart tables, with a sounding in it.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE bathymetry(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        longitude REAL NOT NULL, latitude REAL NOT NULL, depth REAL NOT NULL,
        timestamp INTEGER NOT NULL, heading REAL
      );
      CREATE TABLE reports(
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "fromTimestamp" INTEGER NOT NULL, "toTimestamp" INTEGER NOT NULL
      );
      INSERT INTO bathymetry(longitude, latitude, depth, timestamp)
        VALUES (1, 2, 3, 4);
      PRAGMA user_version = 2;
    `);
    old.close();

    const db = createDB(file);
    const { count } = db
      .prepare("SELECT count(*) AS count FROM bathymetry")
      .get() as { count: number };
    expect(count).toBe(1);
    const store = createCellStore(db);
    store.setMeta("through", "2026-10-16T09:00:00Z");
    expect(store.getMeta("through")).toBe("2026-10-16T09:00:00Z");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the backfill still runs after the live writer has moved the marker on", async () => {
  // The plugin records the gap before the live writer starts; the live writer
  // then advances the marker while the source is still being found.
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(
    Readable.from([
      {
        latitude: 0,
        longitude: 0,
        depth: 3,
        timestamp: at("2026-10-16T08:00:00Z"),
        heading: 0,
      },
    ]),
    source.createWriter!(),
  );
  const store = createCellStore(db);
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"), historySpan(config));

  const live = createCellWriter(store, { flushIntervalMs: 100000 });
  live.write(
    {
      latitude: 1,
      longitude: 1,
      depth: 9,
      timestamp: at("2026-10-16T12:05:00Z"),
    },
    () => {},
  );
  await new Promise<void>((resolve) => live.end(() => resolve()));
  expect(getThrough(store)?.toString()).toBe("2026-10-16T12:05:00Z");

  await backfillCells({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
  });
  expect(cellAt(store, 0, 0)?.passes).toBe(1);
});

test("an interrupted backfill is widened, not lost, on the next start", () => {
  const store = createCellStore(createDB(":memory:"));
  store.setMeta("through", "2026-10-16T10:00:00Z");
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"), historySpan(config));
  const first = getPendingBackfill(store)!;
  expect(first.from.toString()).toBe("2026-10-16T10:00:00Z");
  // The live writer ran for a while before the plugin restarted.
  store.setMeta("through", "2026-10-16T13:00:00Z");
  addPendingBackfill(store, at("2026-10-16T14:00:00Z"), historySpan(config));
  const second = getPendingBackfill(store)!;
  expect(second.from.toString()).toBe(first.from.toString());
  expect(second.to.toString()).toBe("2026-10-16T14:00:00Z");
});

test("a sounding from a clock set in the future can't move the marker past now", async () => {
  const store = createCellStore(createDB(":memory:"));
  const writer = createCellWriter(store, { flushIntervalMs: 100000 });
  writer.write(
    {
      latitude: 0,
      longitude: 0,
      depth: 3,
      timestamp: at("2099-01-01T00:00:00Z"),
    },
    () => {},
  );
  await new Promise<void>((resolve) => writer.end(() => resolve()));
  const through = getThrough(store)!;
  expect(
    Temporal.Instant.compare(through, Temporal.Now.instant()),
  ).toBeLessThanOrEqual(0);
});

test("a flush that keeps failing ends the writer instead of throwing from its timer", () => {
  vi.useFakeTimers();
  try {
    const store = createCellStore(createDB(":memory:"));
    store.addPasses = () => {
      throw new Error("disk full");
    };
    const writer = createCellWriter(store, { flushIntervalMs: 100 });
    writer.on("error", () => {});
    // A track long enough for passes to close, about 30 m a sounding.
    for (let i = 0; i < 40; i++) {
      writer.write(
        {
          latitude: i * 0.0003,
          longitude: 0,
          depth: 3 + (i % 3) * 0.1,
          timestamp: at("2026-10-16T08:00:00Z").add({ seconds: i * 10 }),
        },
        () => {},
      );
    }
    // One failure is tried again; three in a row end the writer.
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    expect(writer.destroyed).toBe(false);
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(writer.destroyed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

/** Enough of the server for startChart: subscriptions, routes, the resource
 * registry, and the Express static mount. */
function serverApp() {
  const routes = new Map<string, (req: unknown, res: unknown) => void>();
  const registerResourceProvider = vi.fn();
  return {
    routes,
    registerResourceProvider,
    app: {
      ...app,
      subscriptionmanager: { subscribe: () => {} },
      getSelfPath: () => undefined,
      get: (path: string, handler: (req: unknown, res: unknown) => void) =>
        routes.set(path, handler),
      use: () => {},
      registerResourceProvider,
    } as unknown as typeof app,
  };
}

test("rebuilds the cells when the offsets change, and re-offers the layer each start", () => {
  const db = createDB(":memory:");
  const { app: server, registerResourceProvider } = serverApp();
  const first = new AbortController();
  startChart({ app: server, config, db, signal: first.signal });
  const store = createCellStore(db);
  store.addPasses([{ py: 1, px: 1, depth: 3, day: 1 }]);
  const stored = () => store.cells(-1, -1, 1, 1).length;
  first.abort();

  // Same configuration: the cells stay.
  const second = new AbortController();
  startChart({ app: server, config, db, signal: second.signal });
  expect(stored()).toBe(1);
  second.abort();

  // New offsets: the old cells would sit beside the new ones, so they go.
  const third = new AbortController();
  startChart({ app: server, config: offsetConfig, db, signal: third.signal });
  expect(stored()).toBe(0);
  third.abort();

  // The server drops a plugin's providers on stop, so each start registers.
  expect(registerResourceProvider).toHaveBeenCalledTimes(3);
});

test("the layer routes need a principal when security is on", () => {
  const { app: server, routes } = serverApp();
  const secured = Object.assign(server, {
    securityStrategy: { isDummy: () => false },
  });
  registerLayerRoutes(secured, () => undefined);
  const meta = [...routes.entries()].find(([path]) =>
    path.endsWith("/style.json"),
  )![1];

  const respond = () => {
    const res = {
      code: 200,
      status(code: number) {
        res.code = code;
        return res;
      },
      json: () => res,
    };
    return res;
  };
  const anonymous = respond();
  meta({}, anonymous);
  expect(anonymous.code).toBe(401);

  const readonly = respond();
  meta(
    { skPrincipal: { identifier: "AUTO", permissions: "readonly" } },
    readonly,
  );
  // Past the access check; no layer is running.
  expect(readonly.code).toBe(503);
});

test("after a depth reference change, the SQLite log only backfills newer soundings", async () => {
  // The log stores depths with the offset of their day, so older rows would
  // come back with the old offset.
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(
    Readable.from([
      {
        latitude: 0,
        longitude: 0,
        depth: 3,
        timestamp: at("2026-10-16T08:00:00Z"),
        heading: 0,
      },
      {
        latitude: 1,
        longitude: 1,
        depth: 4,
        timestamp: at("2026-10-16T10:30:00Z"),
        heading: 0,
      },
    ]),
    source.createWriter!(),
  );
  const store = createCellStore(db);
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"), historySpan(config));
  store.setMeta("depth_since", "2026-10-16T10:00:00Z");

  await backfillCells({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
  });

  expect(cellAt(store, 0, 0)).toBeUndefined();
  expect(cellAt(store, 1, 1)).toBeDefined();
});

test("a first start backfills the SQLite log even though no depth reference was recorded", () => {
  const db = createDB(":memory:");
  const { app: server } = serverApp();
  const signal = new AbortController();
  startChart({ app: server, config, db, signal: signal.signal });
  const store = createCellStore(db);
  expect(store.getMeta("depth_since") ?? "").toBe("");
  expect(getPendingBackfill(store)).toBeDefined();
  signal.abort();
});

test("the backfill doesn't merge soundings past its span again", async () => {
  // Sources round windows out to whole hours; the live writer already has the
  // soundings after the span, so folding them in again would count a pass twice.
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(
    Readable.from([
      {
        latitude: 0,
        longitude: 0,
        depth: 3,
        timestamp: at("2026-10-16T11:50:00Z"),
        heading: 0,
      },
    ]),
    source.createWriter!(),
  );
  const store = createCellStore(db);
  store.setMeta("through", "2026-10-16T11:00:00Z");
  addPendingBackfill(store, at("2026-10-16T11:30:00Z"), historySpan(config));

  await backfillCells({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
  });

  expect(cellAt(store, 0, 0)).toBeUndefined();
});

test("a failing backfill is retried on later starts, then given up", async () => {
  // A source slow to come up at boot gets another chance; one that always
  // fails doesn't cost every start forever.
  const db = createDB(":memory:");
  const { app: server } = serverApp();
  // A log the plugin writes itself, so the backfill doesn't wait out History's delay.
  const failing = {
    createWriter: () => undefined as never,
    createReader: () => undefined,
    getAvailableTimeframes: () => Promise.reject(new Error("history down")),
  };
  const store = createCellStore(db);
  for (let start = 1; start <= 3; start++) {
    const signal = new AbortController();
    const chart = startChart({
      app: server,
      config,
      db,
      signal: signal.signal,
    });
    await chart.backfill(failing);
    if (start < 3) expect(getPendingBackfill(store)).toBeDefined();
    else expect(getPendingBackfill(store)).toBeUndefined();
    signal.abort();
  }
});

test("the backfill reaches back as far as the settings say, however long the layer was off", () => {
  const backfillFrom = (history: History | undefined, through?: string) => {
    const store = createCellStore(createDB(":memory:"));
    if (through) store.setMeta("through", through);
    const settings = { ...config, chart: { history } };
    addPendingBackfill(
      store,
      at("2026-10-16T00:00:00Z"),
      historySpan(settings),
    );
    return getPendingBackfill(store)!.from.toString();
  };
  // The layer was off for two years.
  const through = "2024-10-16T00:00:00Z";
  expect(backfillFrom("month", through)).toBe("2026-09-16T00:00:00Z");
  expect(backfillFrom("year", through)).toBe("2025-10-16T00:00:00Z");
  expect(backfillFrom(undefined, through)).toBe("2025-10-16T00:00:00Z");
  expect(backfillFrom("all", through)).toBe(through);
  // A new layer, from as far back as any source goes.
  expect(backfillFrom("all")).toBe("2017-06-28T00:00:00Z");
});

test("changing how far back the layer fills rebuilds it", () => {
  const position = (history?: string) =>
    cellConfig({ ...config, chart: { history } } as Config).position;
  expect(position("all")).not.toBe(position("year"));
  expect(position("month")).not.toBe(position("year"));
  // Unset, or hand-edited to something else, is the default.
  expect(position()).toBe(position("year"));
  expect(position("forever")).toBe(position("year"));
});

test("a chart that fails to start doesn't stop the plugin", () => {
  const { app: server } = serverApp();
  const errors: string[] = [];
  const failing = Object.assign(server, {
    registerResourceProvider: () => {
      throw new Error("provider refused");
    },
    error: (message: string) => errors.push(message),
  });
  const signal = new AbortController();
  const db = createDB(":memory:");
  expect(
    startChartSafely({ app: failing, config, db, signal: signal.signal }),
  ).toBeUndefined();
  expect(errors[0]).toMatch(/provider refused/);
  // It stopped before anything ran: no live writer, so no gap set aside to backfill.
  expect(getPendingBackfill(createCellStore(db))).toBeUndefined();
  signal.abort();

  expect(
    startChartSafely({
      app: server,
      config: { ...config, chart: { show: false } },
      db: createDB(":memory:"),
      signal: signal.signal,
    }),
  ).toBeUndefined();
});

test("an older start ending late doesn't take down the newer one", async () => {
  const db = createDB(":memory:");
  const { app: server, registerResourceProvider } = serverApp();
  const older = new AbortController();
  startChart({ app: server, config, db, signal: older.signal });
  const newer = new AbortController();
  startChart({ app: server, config, db, signal: newer.signal });
  older.abort();

  // The layer is offered while the newer start runs, and only then.
  const provider = registerResourceProvider.mock.calls.at(-1)![0] as {
    methods: { listResources: () => Promise<Record<string, unknown>> };
  };
  expect(Object.keys(await provider.methods.listResources())).toEqual([
    "crowd-depth",
  ]);
  newer.abort();
  expect(await provider.methods.listResources()).toEqual({});
});

test("a long SQLite backfill lets the server's event loop run", async () => {
  // The SQLite source reads synchronously; without pauses a backfill of weeks
  // of soundings held up the whole Signal K server.
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  const start = at("2026-10-16T00:00:00Z").epochMilliseconds;
  await pipeline(
    Readable.from(
      Array.from({ length: 20_000 }, (_, i) => ({
        latitude: (i % 200) * 0.0001,
        longitude: Math.floor(i / 200) * 0.0001,
        depth: 5,
        timestamp: Temporal.Instant.fromEpochMilliseconds(start + i * 1000),
        heading: 0,
      })),
    ),
    source.createWriter!(),
  );
  const store = createCellStore(db);
  addPendingBackfill(store, at("2026-10-17T00:00:00Z"), historySpan(config));

  // Count turns of the event loop between the first and last sounding read,
  // which is before the writer's own pauses at the end.
  let turns = 0;
  const probe = setInterval(() => turns++, 0);
  let firstRead: number | undefined;
  let lastRead = 0;
  const watched = {
    ...source,
    createReader: async (window: Parameters<typeof source.createReader>[0]) => {
      const reader = await source.createReader(window);
      if (!reader) return reader;
      return Readable.from(
        (async function* () {
          for await (const sounding of reader) {
            firstRead ??= turns;
            lastRead = turns;
            yield sounding;
          }
        })(),
      );
    },
  };
  try {
    await backfillCells({
      app,
      config,
      source: watched,
      store,
      signal: new AbortController().signal,
    });
  } finally {
    clearInterval(probe);
  }
  expect(lastRead - firstRead!).toBeGreaterThan(1);
  expect(getPendingBackfill(store)).toBeUndefined();
});

test("a depth change made while the layer is off is dated when it happens", () => {
  const db = createDB(":memory:");
  const { app: server } = serverApp();
  const first = new AbortController();
  startChart({ app: server, config, db, signal: first.signal });
  first.abort();

  // Off, with a new transducer depth.
  const off = { ...offsetConfig, chart: { show: false } };
  startChartSafely({
    app: server,
    config: off,
    db,
    signal: new AbortController().signal,
  });
  const store = createCellStore(db);
  const since = store.getMeta("depth_since");
  expect(since).toBeTruthy();

  // Turned back on later: no new change, so the date stays.
  const on = new AbortController();
  startChart({ app: server, config: offsetConfig, db, signal: on.signal });
  expect(store.getMeta("depth_since")).toBe(since);
  on.abort();
});

test("a finished backfill isn't folded in again on the next start", async () => {
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(
    Readable.from(
      [10, 5].flatMap((depth, pass) =>
        Array.from({ length: 30 }, (_, i) => ({
          latitude: 36.98 + i * 0.0003,
          longitude: -76.2,
          depth: depth + (i % 3) * 0.1,
          timestamp: at("2026-10-16T00:00:00Z").add({
            hours: pass * 5,
            seconds: i * 10,
          }),
          heading: 0,
        })),
      ),
    ),
    source.createWriter!(),
  );
  const store = createCellStore(db);
  const backfill = async (until: string) => {
    addPendingBackfill(store, at(until), historySpan(config));
    await backfillCells({
      app,
      config,
      source,
      store,
      signal: new AbortController().signal,
    });
  };
  await backfill("2026-10-16T12:00:00Z");
  const first = cellAt(store, -76.2, 36.98 + 10 * 0.0003)!;
  expect(first.passes).toBe(2);
  // The sounder was off since: nothing live moved the marker.
  await backfill("2026-10-16T13:00:00Z");
  expect(cellAt(store, -76.2, 36.98 + 10 * 0.0003)).toEqual(first);
});

test("a fill stopped partway goes on from where it got to", async () => {
  // A track up a meridian, a new cell every sounding.
  const track = Array.from({ length: 900 }, (_, i) => ({
    latitude: 36.98 + i * 0.0003,
    longitude: -76.2,
    depth: 5 + (i % 3) * 0.1,
    timestamp: at("2026-10-16T08:00:00Z").add({ seconds: i * 10 }),
    heading: 0,
  }));
  const fill = async (source: BathymetrySource, store: CellStore) =>
    backfillCells({
      app,
      config,
      source,
      store,
      signal: new AbortController().signal,
    });
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(Readable.from(track), source.createWriter!());
  const clean = createCellStore(createDB(":memory:"));
  startRebuild(clean);
  addPendingBackfill(clean, at("2026-10-16T12:00:00Z"), historySpan(config));
  await fill(source, clean);

  const store = createCellStore(db);
  startRebuild(store);
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"), historySpan(config));
  // Stopped two thirds of the way through.
  const failing: BathymetrySource = {
    ...source,
    createReader: async () =>
      Readable.from(
        (async function* () {
          yield* track.slice(0, 600);
          throw new Error("stopped");
        })(),
      ),
  };
  // Two starts that got nowhere before this one.
  store.setMeta("backfill_failures", "2");
  await expect(fill(failing, store)).rejects.toThrow("stopped");
  const left = getPendingBackfill(store)!;
  expect(Temporal.Instant.compare(left.from, track[200].timestamp)).toBe(1);
  // Further than it was, so the failure doesn't count toward giving the span up.
  expect(recordBackfillFailure(store)).toBe(true);
  expect(store.getMeta("backfill_failures")).toBe("1");
  // The next start finds the span where it got to.
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"), historySpan(config));
  expect(getPendingBackfill(store)).toEqual(left);
  await fill(source, store);
  const cells = (s: CellStore) => s.cells(-76.3, 36.9, -76.1, 37.4);
  expect(cells(store)).toEqual(cells(clean));
});

test("a long span is asked about a year at a time, each hour read once", async () => {
  const store = createCellStore(createDB(":memory:"));
  store.setMeta("backfill", "2024-01-01T00:00:00Z/2026-01-01T00:00:00Z");
  const asked: Timeframe[] = [];
  const read: Timeframe[] = [];
  const source: BathymetrySource = {
    // A provider rounding out to its own hours: the window either side of where
    // one request ends and the next starts.
    getAvailableTimeframes: async (span) => {
      asked.push(span);
      return [
        new Timeframe(
          span.from.subtract({ minutes: 30 }),
          span.from.add({ minutes: 30 }),
        ),
        new Timeframe(
          span.to.subtract({ minutes: 30 }),
          span.to.add({ minutes: 30 }),
        ),
      ];
    },
    createReader: async (window) => {
      read.push(window);
      return undefined;
    },
  };
  await backfillCells({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
  });
  expect(asked).toHaveLength(3);
  for (const span of asked) {
    expect(span.to.since(span.from).total("hours")).toBeLessThanOrEqual(
      365 * 24,
    );
  }
  const hours = read.reduce((n, w) => n + w.to.since(w.from).total("hours"), 0);
  // Half an hour at each end of each request, nothing twice.
  expect(hours).toBe(asked.length);
  for (let i = 1; i < read.length; i++) {
    expect(
      Temporal.Instant.compare(read[i - 1].to, read[i].from),
    ).toBeLessThanOrEqual(0);
  }
});

test("a database from a preview build moves to cells", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
  try {
    const file = join(dir, "bathymetry.sqlite");
    createDB(file).close();
    // Back to the preview's schema: its tile pyramid at user_version 3.
    const old = new DatabaseSync(file);
    old.exec(`
      DROP TABLE cells; DROP TABLE overviews; DROP TABLE shoals;
      CREATE TABLE tiles(z INTEGER, x INTEGER, y INTEGER, cells BLOB, updated INTEGER);
      INSERT INTO tile_meta(key, value) VALUES ('through', '2026-10-16T09:00:00Z');
      PRAGMA user_version = 3;
    `);
    old.close();
    const db = createDB(file);
    const store = createCellStore(db);
    store.addPasses([{ py: 1, px: 1, depth: 3, day: 1 }]);
    expect(store.cells(-1, -1, 1, 1)).toHaveLength(1);
    // The preview's marker described its tiles, not these cells.
    expect(store.getMeta("through")).toBeUndefined();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a backfill that fails partway still leaves its cells drawn zoomed out", async () => {
  const store = createCellStore(createDB(":memory:"));
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"), historySpan(config));
  const start = at("2026-10-16T08:00:00Z");
  const failing = {
    createWriter: () => undefined as never,
    getAvailableTimeframes: async () => [
      new Timeframe(start, start.add({ hours: 1 })),
    ],
    createReader: async () =>
      Readable.from(
        (async function* () {
          for (let i = 0; i < 300; i++) {
            yield {
              latitude: 36.98 + i * 0.0003,
              longitude: -76.2,
              depth: 5 + (i % 3) * 0.1,
              timestamp: start.add({ seconds: i * 10 }),
              heading: 0,
            };
          }
          throw new Error("history went away");
        })(),
      ),
  };
  await expect(
    backfillCells({
      app,
      config,
      source: failing,
      store,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/history went away/);
  expect(store.cells(-76.3, 36.9, -76.1, 37.1).length).toBeGreaterThan(0);
  expect(store.cells(-76.3, 36.9, -76.1, 37.1, 6).length).toBeGreaterThan(0);
});

test("cells a stopped backfill left without overviews get them on the next start", async () => {
  const store = createCellStore(createDB(":memory:"));
  const { py, px } = { py: 199_691, px: -411_481 };
  store.addPasses([{ py, px, depth: 5, day: 1 }], false);
  store.setMeta("overviews_stale", "1");
  expect(store.cells(-76.3, 36.9, -76.1, 37.1, 6)).toHaveLength(0);
  // Nothing left to backfill, as when History is down and the local log is empty.
  await backfillCells({
    app,
    config,
    source: createSqliteSource(app, createDB(":memory:")),
    store,
    signal: new AbortController().signal,
  });
  expect(store.cells(-76.3, 36.9, -76.1, 37.1, 6)).toHaveLength(1);
});
