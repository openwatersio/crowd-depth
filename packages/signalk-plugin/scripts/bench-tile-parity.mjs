// After building: node scripts/bench-tile-parity.mjs /baseline/dist/tiles/surface.js
// Compare exact tile bytes against the preceding renderer on synthetic scenes.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildTile } from "../dist/tiles/surface.js";
import { cellAt, tileFraction } from "../dist/tiles/geometry.js";
if (!process.argv[2])
  throw new Error("provide the preceding build's surface.js module");
const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
let checked = 0;
for (const lat of [0, 37, 70, -60])
  for (const lon of [-76, 179.999]) {
    const cells = Array.from({ length: 300 }, (_, i) => ({
      ...cellAt(lon + (i % 3) * 0.0003, lat + (Math.floor(i / 3) - 50) / 5400),
      m: -2 + (i % 40),
      d: 0.1 + (i % 9) * 0.2,
      passes: 2,
      first: 20000,
      last: 20010,
    }));
    const shoals = [{ lon, lat, depth: 0.25 }];
    for (const z of [10, 13, 14, 15])
      for (const detail of ["high", "standard"]) {
        const f = tileFraction(lon, lat, z),
          x = Math.floor(f.x),
          y = Math.floor(f.y);
        assert.deepEqual(
          buildTile(z, x, y, cells, shoals, detail),
          baseline.buildTile(z, x, y, cells, shoals, detail),
          JSON.stringify({ lat, lon, z, detail }),
        );
        checked++;
      }
  }
console.log(JSON.stringify({ byteIdenticalTiles: checked }));
