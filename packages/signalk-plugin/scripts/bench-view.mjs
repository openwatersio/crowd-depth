// Time a chart view of the live layer from a cell database, as a plotter zooming in: cold
// tiles of a 5 by 4 view at zoom 13, then 14, then 15, built on this thread, each zoom's
// tiles taken by the ancestor whose surface they share, as the service sends them to one
// worker; with the bytes and vertices each zoom sends, counted outside the timing.
//
//   npm run build && node scripts/bench-view.mjs <bathymetry.sqlite> [lon lat] [high|standard]
//
// Run it from a checkout of this repository, with its dev dependencies installed: the
// published plugin has no scripts. The database is opened read-only, each tile in a read
// transaction as a tile worker reads it, so it can be the plugin's own, in the server's
// data directory (usually `~/.signalk/plugin-config-data/crowd-depth/bathymetry.sqlite`),
// while the server runs. Without a position, the view is centred where the boat has the
// most cells, not the most passes, which a berth would win.
import { DatabaseSync } from "node:sqlite";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { createCellStore } from "../dist/tiles/cells.js";
import { cellCenter, tileFraction } from "../dist/tiles/geometry.js";
import { clearShared, readTile } from "../dist/tiles/service.js";
import { sharedTile } from "../dist/tiles/surface.js";

const [file, lonArg, latArg, detailArg] = process.argv.slice(2);
if (!file) {
  console.error(
    "usage: node scripts/bench-view.mjs <bathymetry.sqlite> [lon lat] [high|standard]",
  );
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
// Read-only, it can't migrate: a database from a build without the live layer, or an
// older one, says so rather than failing on a missing table or column.
const columns = db.prepare("SELECT name FROM pragma_table_info('cells')").all();
if (!columns.some((c) => c.name === "t")) {
  console.error(
    "this database has no cells, or older ones: run a plugin build with the live layer, and let its backfill finish",
  );
  process.exit(1);
}
const store = createCellStore(db);
// The detail alone may stand where the position would.
const positioned =
  latArg !== undefined && !["high", "standard"].includes(lonArg);
const detail = (positioned ? detailArg : lonArg) ?? "high";
if (!["high", "standard"].includes(detail)) {
  console.error(`detail must be high or standard, not ${detail}`);
  process.exit(1);
}
let lon = Number(lonArg);
let lat = Number(latArg);
if (!positioned) {
  // Blocks of 64 by 64 cells, about 1.3 km a side.
  const busiest = db
    .prepare(
      `SELECT CAST(avg(py) AS INTEGER) AS py, CAST(avg(px) AS INTEGER) AS px
       FROM cells GROUP BY py / 64, px / 64 ORDER BY count(*) DESC LIMIT 1`,
    )
    .get();
  if (!busiest) throw new Error("no cells in the database");
  ({ lon, lat } = cellCenter(busiest.py, busiest.px));
} else if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
  console.error(`not a position: ${lonArg} ${latArg}`);
  process.exit(1);
}
console.log(
  `${db.prepare("SELECT count(*) AS n FROM cells").get().n} cells; view at ${lon.toFixed(5)}, ${lat.toFixed(5)}, ${detail} detail`,
);

let total = 0;
for (const z of [13, 14, 15]) {
  // Cold: no surface kept from the zoom before.
  clearShared(store);
  const f = tileFraction(lon, lat, z);
  const n = 2 ** z;
  // Across the antimeridian, the tile on the other side, as the service asks for.
  const view = Array.from({ length: 20 }, (_, i) => [
    (((Math.floor(f.x) + (i % 5) - 2) % n) + n) % n,
    Math.floor(f.y) + Math.floor(i / 5) - 2,
  ]);
  const key = ([x, y]) => {
    const a = sharedTile(z, x, y);
    return a.y * 2 ** a.z + a.x;
  };
  view.sort((a, b) => key(a) - key(b));
  const vertices = {};
  let bytes = 0;
  let tiles = 0;
  let ms = 0;
  for (const [x, y] of view) {
    const t0 = performance.now();
    db.exec("BEGIN");
    let tile;
    try {
      tile = readTile(store, z, x, y, detail, true);
    } finally {
      db.exec("COMMIT");
    }
    ms += performance.now() - t0;
    if (!tile) continue;
    tiles++;
    bytes += tile.length;
    const vt = new VectorTile(new PbfReader(tile));
    for (const [name, layer] of Object.entries(vt.layers)) {
      for (let k = 0; k < layer.length; k++) {
        const feature = layer.feature(k);
        const key =
          name === "DEPCNT" && feature.properties.unit
            ? `DEPCNT ${feature.properties.unit}`
            : name;
        for (const ring of feature.loadGeometry()) {
          vertices[key] = (vertices[key] ?? 0) + ring.length;
        }
      }
    }
  }
  total += ms;
  const sum = Object.values(vertices).reduce((a, b) => a + b, 0);
  console.log(
    `z${z}: ${ms.toFixed(0)} ms for 20 tiles (${tiles} with soundings), ${(bytes / 1024).toFixed(0)} KB, ${sum} vertices ${JSON.stringify(vertices)}`,
  );
}
console.log(`zoomed in from 13 to 15 in ${(total / 1000).toFixed(1)} s`);
db.close();
