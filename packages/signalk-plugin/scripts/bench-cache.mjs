// What the live layer's tile cache holds and costs as a plotter wanders a store: pan a
// 5 by 4 view over a grid of positions at zooms 10 to 15, on the tile threads as the
// plugin builds them, and report the process's memory; then restart the service, as the
// plugin does on a restart, and time the first view again.
//
//   npm run build && node scripts/bench-cache.mjs <bathymetry.sqlite> [lon lat] [steps]
//
// The database is migrated and written to, tiles kept on disk among it, so give it a
// copy. Without a position, the walk is centred where the boat has the most cells. It
// runs against older builds too, which keep tiles in memory only.
import { DatabaseSync } from "node:sqlite";
import { createDB } from "../dist/storage.js";
import { createCellStore } from "../dist/tiles/cells.js";
import { cellCenter, tileFraction } from "../dist/tiles/geometry.js";
import * as service from "../dist/tiles/service.js";
import * as tiles from "../dist/tiles/index.js";

const [file, lonArg, latArg, stepsArg] = process.argv.slice(2);
if (!file) {
  console.error(
    "usage: node scripts/bench-cache.mjs <bathymetry.sqlite> [lon lat] [steps]",
  );
  process.exit(1);
}
const db = createDB(file);
const store = createCellStore(db);
let lon = Number(lonArg);
let lat = Number(latArg);
if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
  const busiest = new DatabaseSync(file, { readOnly: true })
    .prepare(
      `SELECT CAST(avg(py) AS INTEGER) AS py, CAST(avg(px) AS INTEGER) AS px
       FROM cells GROUP BY py / 64, px / 64 ORDER BY count(*) DESC LIMIT 1`,
    )
    .get();
  ({ lon, lat } = cellCenter(busiest.py, busiest.px));
}
const steps = Number(stepsArg ?? 3);
const kept = () => tiles.createKeptTiles?.(db, "high");
const start = () => service.createTileService(store, file, "high", kept());

const view = (s, z, lo, la) => {
  const f = tileFraction(lo, la, z);
  return Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      s.get(
        z,
        Math.floor(f.x) + (i % 5) - 2,
        Math.floor(f.y) + Math.floor(i / 5) - 2,
      ),
    ),
  );
};
const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;
const memory = () => {
  globalThis.gc?.();
  const m = process.memoryUsage();
  return `rss ${mb(m.rss)}, heap ${mb(m.heapUsed)}, buffers ${mb(m.arrayBuffers)}`;
};

console.log(`view at ${lon.toFixed(5)}, ${lat.toFixed(5)}; ${memory()}`);
let s = start();
const t0 = performance.now();
let n = 0;
for (const z of [10, 11, 12, 13, 14, 15]) {
  // A view is 5 × 4 tiles; step a view at a time over a steps × steps grid.
  const w = (5 * 360) / 2 ** z;
  const h = (4 * 360 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const tilesOut = await view(
        s,
        z,
        lon + (i - (steps - 1) / 2) * w,
        lat + (j - (steps - 1) / 2) * h,
      );
      n += tilesOut.length;
    }
  }
  console.log(
    `z${z}: ${n} tiles asked for, ${((performance.now() - t0) / 1000).toFixed(1)} s; ${memory()}`,
  );
}
const kb = db
  .prepare("SELECT name FROM sqlite_master WHERE name = 'kept_tiles'")
  .get()
  ? db
      .prepare("SELECT count(*) AS n, total(length(tile)) AS b FROM kept_tiles")
      .get()
  : undefined;
if (kb) console.log(`kept on disk: ${kb.n} tiles, ${mb(kb.b)}`);
s.close();

// A restart: a new service, as the plugin starts one.
s = start();
for (const z of [13, 14, 15]) {
  const t = performance.now();
  await view(s, z, lon, lat);
  console.log(
    `after a restart, z${z} view: ${((performance.now() - t) / 1000).toFixed(2)} s`,
  );
}
s.close();
db.close();
