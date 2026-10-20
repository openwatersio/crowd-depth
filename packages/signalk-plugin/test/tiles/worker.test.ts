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
