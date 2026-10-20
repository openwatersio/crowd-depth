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
      expect(store.cells(-76.3, 36.9, -76.1, 38).length).toBeGreaterThan(2000);
      expect(store.cells(-76.3, 36.9, -76.1, 38, 6).length).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
