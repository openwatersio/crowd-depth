// Compare prepared fields exactly, then time sparse/dense raster preparation.
// node scripts/bench-prepare.mjs /baseline/dist/tiles/portray.js
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepare } from "../dist/tiles/portray.js";
import { surface } from "../dist/tiles/surface.js";
import { cellAt, tileFraction } from "../dist/tiles/geometry.js";
if (!process.argv[2]) throw new Error("provide preceding portrayal module");
const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
const origin = cellAt(-76.2, 36.98),
  tile = tileFraction(-76.2, 36.98, 13);
for (const count of [1, 100, 3600]) {
  const cells = Array.from({ length: count }, (_, i) => ({
    py: origin.py + (count === 100 ? i * 2 - 100 : (i % 60) - 30),
    px: origin.px + (count === 100 ? i * 2 - 100 : Math.floor(i / 60) - 30),
    m: 3 + (i % 17),
    d: 0.2,
    passes: 2,
    first: 20000,
    last: 20001,
  }));
  const raster = surface(13, Math.floor(tile.x), Math.floor(tile.y), cells);
  assert.deepEqual(prepare(raster), baseline.prepare(raster));
  const times = [[], []],
    variants = [baseline.prepare, prepare];
  for (let r = 0; r < 20; r++)
    for (const i of r % 2 ? [1, 0] : [0, 1]) {
      const t = performance.now();
      variants[i](raster);
      if (r >= 5) times[i].push(performance.now() - t);
    }
  console.log(
    JSON.stringify({
      cells: count,
      baselineMs: times[0],
      candidateMs: times[1],
    }),
  );
}
