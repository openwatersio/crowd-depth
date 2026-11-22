import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// The worker thread loads the built module, so this runs against dist/, which CI
// builds before the tests.
const dist = new URL("../../dist/tiles/service.js", import.meta.url);

test.skipIf(!existsSync(dist))(
  "tiles build on a worker thread from the database file, current after a write",
  async () => {
    const { createDB } = await import("../../dist/storage.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { createTileService } = await import("../../dist/tiles/service.js");
    const { cellAt, tileFraction } =
      await import("../../dist/tiles/geometry.js");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
    const file = join(dir, "bathymetry.sqlite");
    const db = createDB(file);
    const store = createCellStore(db);
    const tiles = createTileService(store, file);
    try {
      const f = tileFraction(-76.2, 36.98, 14);
      const at = [14, Math.floor(f.x), Math.floor(f.y)] as const;
      expect(await tiles.get(...at)).toBeUndefined();

      const { py, px } = cellAt(-76.2, 36.98);
      store.addPasses([{ py, px, depth: 6, day: 20000 }]);
      tiles.changed([{ lon: -76.2, lat: 36.98 }]);
      const tile = await tiles.get(...at);
      expect(tile?.length).toBeGreaterThan(0);
    } finally {
      tiles.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!existsSync(dist))(
  "tiles that share an ancestor's surface draw cells a backfill writes",
  async () => {
    const { createDB } = await import("../../dist/storage.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { createTileService } = await import("../../dist/tiles/service.js");
    const { cellAt, tileFraction } =
      await import("../../dist/tiles/geometry.js");
    const { VectorTile } = await import("@mapbox/vector-tile");
    const { PbfReader } = await import("pbf");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
    const file = join(dir, "bathymetry.sqlite");
    const db = createDB(file);
    const store = createCellStore(db);
    const tiles = createTileService(store, file);
    const pass = (depth: number) =>
      Array.from({ length: 60 }, (_, i) => ({
        ...cellAt(-76.2, 36.975 + i / 5400),
        depth,
        day: 20000,
      }));
    const bands = async (x: number, y: number) => {
      const t = await tiles.get(15, x, y);
      const l = t && new VectorTile(new PbfReader(t)).layers.DEPARE;
      return l
        ? Array.from(
            { length: l.length },
            (_, i) => l.feature(i).properties.DRVAL1,
          )
        : [];
    };
    try {
      const f = tileFraction(-76.2, 36.98, 15);
      const [x, y] = [Math.floor(f.x), Math.floor(f.y)];
      store.addPasses(pass(8));
      tiles.changed([{ lon: -76.2, lat: 36.98 }]);
      // A backfill starts, and a tile is built while it runs.
      tiles.share(false);
      const before = await bands(x, y);
      // Written as a backfill writes, on its own connection, which tells the tile
      // service only when it ends.
      const backfill = createCellStore(createDB(file));
      for (let k = 0; k < 20; k++) backfill.addPasses(pass(30));
      // A tile beside it, not built yet, under the same ancestor.
      const sibling = await bands(x, y ^ 1);
      expect(before.length).toBeGreaterThan(0);
      expect(sibling.length).toBeGreaterThan(0);
      expect(Math.min(...sibling)).toBeGreaterThan(Math.max(...before));
    } finally {
      tiles.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!existsSync(dist))(
  "a backfill writes its cells and overviews on a worker thread",
  async () => {
    const { Readable } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    const { Temporal } = await import("@js-temporal/polyfill");
    const { createDB } = await import("../../dist/storage.js");
    const { createSqliteSource } = await import("../../dist/sources/sqlite.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { addPendingBackfill, backfillCells } =
      await import("../../dist/tiles/backfill.js");
    const { app, config } = await import("../helper.js");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
    const file = join(dir, "bathymetry.sqlite");
    const db = createDB(file);
    try {
      const source = createSqliteSource(app, db);
      const start = Temporal.Instant.from("2026-10-16T08:00:00Z");
      await pipeline(
        Readable.from(
          Array.from({ length: 3000 }, (_, i) => ({
            latitude: 36.98 + i * 0.0003,
            longitude: -76.2,
            depth: 5 + (i % 3) * 0.1,
            timestamp: start.add({ seconds: i * 10 }),
            heading: 0,
          })),
        ),
        source.createWriter!(),
      );
      const store = createCellStore(db);
      addPendingBackfill(store, start.add({ hours: 12 }));
      await backfillCells({
        app,
        config,
        source,
        store,
        signal: new AbortController().signal,
        file,
      });
      // A sounding every 33 m in 20.5 m rows: one cell each, none dropped.
      expect(store.cells(-76.3, 36.9, -76.1, 38)).toHaveLength(3000);
      expect(store.cells(-76.3, 36.9, -76.1, 38, 6).length).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!existsSync(dist))(
  "a backfill hands each sounding's tide to the worker, which reduces it",
  async () => {
    const { Readable } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    const { Temporal } = await import("@js-temporal/polyfill");
    const { createDB } = await import("../../dist/storage.js");
    const { createSqliteSource } = await import("../../dist/sources/sqlite.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { addPendingBackfill, backfillCells } =
      await import("../../dist/tiles/backfill.js");
    const { app, config } = await import("../helper.js");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
    const file = join(dir, "bathymetry.sqlite");
    const db = createDB(file);
    try {
      const source = createSqliteSource(app, db);
      const start = Temporal.Instant.from("2026-10-16T08:00:00Z");
      await pipeline(
        Readable.from(
          Array.from({ length: 300 }, (_, i) => ({
            latitude: 36.98 + i * 0.0003,
            longitude: -76.2,
            depth: 5 + (i % 3) * 0.1,
            timestamp: start.add({ seconds: i * 10 }),
            heading: 0,
          })),
        ),
        source.createWriter!(),
      );
      const store = createCellStore(db);
      addPendingBackfill(store, start.add({ hours: 12 }));
      const tides = {
        at: async () => ({ level: 1, sigma: 0.3 }),
        ready: async () => true,
      };
      await backfillCells({
        app,
        config,
        source,
        store,
        signal: new AbortController().signal,
        file,
        tides: tides as never,
      });
      const cells = store.cells(-76.3, 36.9, -76.1, 38);
      expect(cells).toHaveLength(300);
      for (const c of cells) {
        expect(c.t).toBe(0.3);
        expect(c.m).toBeLessThan(4.3);
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!existsSync(dist))(
  "track QC on its thread finds what it finds here",
  async () => {
    const { createQCThread } = await import("../../dist/tiles/qc-thread.js");
    const { trackQC } = await import("../../dist/qc.js");
    const { DEFINITIONS } = await import("../../dist/tiles/geometry.js");
    const soundings = Array.from({ length: 2000 }, (_, i) => ({
      time: 1_790_000_000_000_000 + i * 1_000_000,
      lon: -76.2,
      lat: 36.98 + (i * 3) / 110540,
      depth: i % 97 === 0 ? 1 : i >= 800 && i < 900 ? 70 : 6 + (i % 5) * 0.1,
    }));
    const arrival = Date.now() * 1000;
    const thread = createQCThread();
    try {
      const here = trackQC(soundings, arrival, DEFINITIONS.qc).map(
        ([i, flag]) => [i, flag],
      );
      expect(here.length).toBeGreaterThan(0);
      expect(await thread.run(soundings, arrival)).toEqual(here);
    } finally {
      thread.close();
    }
  },
);

test.skipIf(!existsSync(dist))(
  "a fill on the worker thread stopped partway goes on from where it got to",
  async () => {
    const { Readable } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    const { Temporal } = await import("@js-temporal/polyfill");
    const { createDB } = await import("../../dist/storage.js");
    const { createSqliteSource } = await import("../../dist/sources/sqlite.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { Timeframe } = await import("../../dist/types.js");
    const {
      addPendingBackfill,
      backfillCells,
      getPendingBackfill,
      startRebuild,
    } = await import("../../dist/tiles/backfill.js");
    const { app, config } = await import("../helper.js");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
    const file = join(dir, "bathymetry.sqlite");
    const db = createDB(file);
    try {
      const start = Temporal.Instant.from("2026-10-16T00:00:00Z");
      const until = start.add({ hours: 24 });
      // Up a meridian, a new cell every sounding, enough for several of the worker's
      // batches before it stops.
      const track = Array.from({ length: 6000 }, (_, i) => ({
        latitude: 36.98 + i * 0.0003,
        longitude: -76.2,
        depth: 5 + (i % 3) * 0.1,
        timestamp: start.add({ seconds: i * 10 }),
        heading: 0,
      }));
      const source = createSqliteSource(app, db);
      await pipeline(Readable.from(track), source.createWriter!());
      const fill = (
        store: ReturnType<typeof createCellStore>,
        from: typeof source,
        on?: string,
      ) =>
        backfillCells({
          app,
          config,
          source: from,
          store,
          signal: new AbortController().signal,
          ...(on && { file: on }),
        });

      const clean = createCellStore(createDB(":memory:"));
      startRebuild(clean);
      addPendingBackfill(clean, until);
      await fill(clean, source);

      const store = createCellStore(db);
      startRebuild(store);
      addPendingBackfill(store, until);
      const failing = {
        ...source,
        getAvailableTimeframes: async () => [new Timeframe(start, until)],
        createReader: async () =>
          Readable.from(
            (async function* () {
              yield* track.slice(0, 4500);
              throw new Error("stopped");
            })(),
          ),
      };
      await expect(fill(store, failing, file)).rejects.toThrow("stopped");
      const left = getPendingBackfill(store)!;
      expect(Temporal.Instant.compare(left.from, track[1000].timestamp)).toBe(
        1,
      );
      addPendingBackfill(store, until);
      await fill(store, source, file);
      const cells = (s: ReturnType<typeof createCellStore>) =>
        s.cells(-76.3, 36.9, -76.1, 39);
      expect(cells(store)).toHaveLength(6000);
      expect(cells(store)).toEqual(cells(clean));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!existsSync(dist))(
  "tiles are built ahead and kept, and a change under way in a plotter's view is built again into memory",
  async () => {
    const { createDB } = await import("../../dist/storage.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { createKeptTiles } = await import("../../dist/tiles/kept.js");
    const { createTileService, readTile, tilesNear } =
      await import("../../dist/tiles/service.js");
    const { cellAt, cellCenter, tileBounds, tileFraction } =
      await import("../../dist/tiles/geometry.js");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
    const file = join(dir, "bathymetry.sqlite");
    const db = createDB(file);
    const store = createCellStore(db);
    const pass = (depth: number) =>
      Array.from({ length: 60 }, (_, i) => ({
        ...cellAt(-76.2, 36.975 + i / 5400),
        depth,
        day: 20000,
      }));
    store.addPasses(pass(8));
    // A second pass over the southern sixth of the first.
    const again = pass(3).slice(0, 10);
    const changed = again.map((c) => cellCenter(c.py, c.px));
    const kept = createKeptTiles(db, "high");
    let done!: () => void;
    let built = new Promise<void>((r) => (done = r));
    let log = "";
    const tiles = createTileService(store, file, "high", kept, {
      position: () => ({ lon: -76.2, lat: 36.98 }),
      log: (m) => {
        log = m;
        done();
      },
    });
    try {
      await built;
      const near = tilesNear(store);
      expect(near.length).toBeGreaterThan(12);
      for (const [z, x, y] of near) expect(kept.size(z, x, y)).toBeDefined();

      const f = tileFraction(-76.2, 36.976, 15);
      const at = [15, Math.floor(f.x), Math.floor(f.y)] as const;
      built = new Promise<void>((r) => (done = r));
      store.addPasses(again);
      // A plotter showing that one zoom 15 tile; elsewhere, the changed tiles wait to
      // settle, or to be asked for.
      const e = 1e-9;
      const b = tileBounds(...at);
      tiles.watched([15, b.west + e, b.south + e, b.east - e, b.north - e]);
      // Another plotter's poll, with no view and then one far off, leaves that view.
      tiles.watched();
      tiles.watched([15, 10, 10, 10.01, 10.01]);
      tiles.changed(changed);
      await built;
      expect(log).toMatch(/^built 1 tiles ahead/);
      // Changed within KEEP_QUIET_MS: built into memory, not onto the SD card.
      expect(kept.size(...at)).toBeUndefined();
      expect(await tiles.get(...at)).toEqual(
        readTile(store, ...at, "high", false),
      );
      // Its zoom 14 ancestor changed too, out of view: not built until it's asked for.
      const up = [14, at[1] >> 1, at[2] >> 1] as const;
      expect(kept.size(...up)).toBeUndefined();
      expect(await tiles.get(...up)).toEqual(
        readTile(store, ...up, "high", false),
      );
    } finally {
      tiles.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!existsSync(dist))(
  "kept tiles that can't be read stop building ahead, not the layer",
  async () => {
    const { createDB } = await import("../../dist/storage.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { createKeptTiles } = await import("../../dist/tiles/kept.js");
    const { createTileService } = await import("../../dist/tiles/service.js");
    const { cellAt } = await import("../../dist/tiles/geometry.js");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
    const file = join(dir, "bathymetry.sqlite");
    const db = createDB(file);
    const store = createCellStore(db);
    store.addPasses([{ ...cellAt(-76.2, 36.98), depth: 6, day: 20000 }]);
    const fail = () => {
      throw new Error("disk I/O error");
    };
    const kept = {
      ...createKeptTiles(db, "high"),
      size: fail,
      full: fail,
    };
    const tiles = createTileService(store, file, "high", kept, {
      position: () => ({ lon: -76.2, lat: 36.98 }),
    });
    try {
      expect(() => tiles.changed([{ lon: -76.2, lat: 36.98 }])).not.toThrow();
    } finally {
      tiles.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!existsSync(dist))(
  "backfill publishes cells and overviews before its source finishes",
  async () => {
    const { Readable } = await import("node:stream");
    const { Temporal } = await import("@js-temporal/polyfill");
    const { createDB } = await import("../../dist/storage.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { addPendingBackfill, backfillCells } =
      await import("../../dist/tiles/backfill.js");
    const { Timeframe } = await import("../../dist/types.js");
    const { app, config } = await import("../helper.js");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-progressive-"));
    const file = join(dir, "b.sqlite"),
      db = createDB(file),
      store = createCellStore(db);
    const from = Temporal.Instant.from("2026-10-16T00:00:00Z"),
      to = from.add({ hours: 1 });
    store.setMeta("backfill", `${from}/${to}`);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false,
      published = false,
      sawOverview = false;
    const source = {
      getAvailableTimeframes: () => [new Timeframe(from, to)],
      createReader: () =>
        Readable.from(
          (async function* () {
            for (let i = 0; i < 3000; i++)
              yield {
                longitude: -80 + i * 0.0001,
                latitude: 26,
                depth: 6 + (i % 3) * 0.1,
                timestamp: from.add({ seconds: i }),
              };
            await gate;
            finished = true;
          })(),
        ),
    };
    try {
      addPendingBackfill(store, to);
      await backfillCells({
        app,
        config,
        source,
        store,
        file,
        signal: new AbortController().signal,
        onChange: (positions) => {
          expect(positions.length).toBeGreaterThan(0);
          expect(positions[0]).toEqual({
            lon: expect.any(Number),
            lat: expect.any(Number),
          });
          if (!finished) {
            published = true;
            sawOverview ||= store.cells(-81, 25, -79, 27, 2).length > 0;
            release();
          }
        },
      });
      expect(published).toBe(true);
      expect(sawOverview).toBe(true);
      expect(finished).toBe(true);
    } finally {
      release();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!existsSync(dist))(
  "recent-first refinement commits on its worker before discovering old history",
  async () => {
    const { createDB } = await import("../../dist/storage.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { refineHistory } = await import("../../dist/tiles/refine.js");
    const { Temporal } = await import("@js-temporal/polyfill");
    const { Readable } = await import("node:stream");
    const { config } = await import("../helper.js");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-recent-"));
    const file = join(dir, "b.sqlite"),
      db = createDB(file),
      store = createCellStore(db);
    const from = Temporal.Instant.from("2026-10-01T00:00Z"),
      to = from.add({ hours: 2 });
    store.setMeta("backfill", `${from}/${to}`);
    let published = false;
    try {
      await refineHistory({
        store,
        config,
        file,
        signal: new AbortController().signal,
        source: {
          createReader: (window) =>
            Readable.from(
              Array.from({ length: 600 }, (_, i) => ({
                longitude: -80 + i * 0.00001,
                latitude: 26,
                depth: 5 + (i % 3) * 0.1,
                timestamp: window.from.add({ seconds: i }),
              })),
            ),
          getAvailableTimeframes: () => {
            expect(published).toBe(true);
            return [];
          },
        },
        onChange: (changed) => {
          expect(changed.length).toBeGreaterThan(0);
          expect(store.cells(-81, 25, -79, 27).length).toBeGreaterThan(0);
          expect(store.cells(-81, 25, -79, 27, 6).length).toBeGreaterThan(0);
          published = true;
        },
      });
      expect(published).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!existsSync(dist))(
  "starting a stored chart queues no speculative tile builds",
  async () => {
    const { createDB } = await import("../../dist/storage.js");
    const { createCellStore } = await import("../../dist/tiles/cells.js");
    const { cellAt } = await import("../../dist/tiles/geometry.js");
    const { startChart, cellConfig } = await import("../../dist/chart.js");
    const { app, config } = await import("../helper.js");
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-demand-"));
    const db = createDB(join(dir, "chart.sqlite"));
    const controller = new AbortController();
    const store = createCellStore(db),
      settings = cellConfig(config);
    store.setMeta("config_position", settings.position);
    store.setMeta("config_depth", settings.depth);
    store.setMeta("config_weight", settings.weight);
    store.addPasses([{ ...cellAt(-80, 26), depth: 5, day: 20000 }]);
    try {
      startChart({
        app: {
          ...app,
          subscriptionmanager: { subscribe: () => {} },
          getSelfPath: () => undefined,
          get: () => {},
          use: () => {},
          registerResourceProvider: () => {},
        } as typeof app,
        config,
        db,
        signal: controller.signal,
      });
      expect(db.prepare("SELECT count(*) n FROM kept_tiles").get()).toEqual({
        n: 0,
      });
    } finally {
      controller.abort();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
