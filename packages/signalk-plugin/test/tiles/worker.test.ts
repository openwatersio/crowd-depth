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
      const before = await bands(x, y);
      // Written as a backfill writes, which tells the tile service nothing until it ends.
      for (let k = 0; k < 20; k++) store.addPasses(pass(30));
      // A tile beside it, not built yet, cut from the same ancestor's surface.
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
