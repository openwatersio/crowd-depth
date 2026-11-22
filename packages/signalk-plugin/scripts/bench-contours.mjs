// After building: node scripts/bench-contours.mjs /baseline/dist/tiles/portray.js
// Alternate baseline/candidate runs; assert exact contour geometry before timing.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isolines } from "../dist/tiles/portray.js";
if (!process.argv[2]) throw new Error("provide the preceding portrayal module");
const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
const m = 256;
const depth = Float64Array.from(
  { length: m * m },
  (_, i) => 10 + 8 * Math.sin((i % m) / 20) * Math.cos(Math.floor(i / m) / 30),
);
const ones = new Float64Array(m * m).fill(1);
const t = {
  m,
  u: 1,
  depth,
  wet: depth,
  depthSlope: ones,
  wetSlope: ones,
  extent: ones,
  measured: ones,
  toTile: (x) => Math.round(x * 16),
};
// Also exercise the wet/dry threshold, unequal slopes, clipped coverage, and
// each marching-squares mask independently of the timed smooth-water fixture.
const wet = Float64Array.from(depth, (d) => d - 6);
const slopes = Float64Array.from(depth, (_, i) => 0.5 + (i % 7) / 4);
const extent = Float64Array.from(depth, (_, i) => (i % 5 ? 1 : -1));
const mixed = { ...t, wet, extent, wetSlope: slopes };
assert.deepEqual(
  isolines(mixed, [0, 2, 10], 8),
  baseline.isolines(mixed, [0, 2, 10], 8),
);
for (let mask = 0; mask < 16; mask++) {
  const field = Float64Array.from([0, 1, 3, 2], (bit) =>
    mask & (1 << bit) ? 1 : -1,
  );
  const tile = { ...t, m: 2, depth: field, wet: field };
  assert.deepEqual(isolines(tile, [0], 0), baseline.isolines(tile, [0], 0));
}
for (const levels of [[], [5, 10, 15], [2, 4, 6, 8, 10, 12, 14, 16, 18]]) {
  assert.deepEqual(isolines(t, levels, 8), baseline.isolines(t, levels, 8));
  const times = [[], []];
  const variants = [baseline.isolines, isolines];
  for (let round = 0; round < 30; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      for (let repeat = 0; repeat < 5; repeat++) variants[index](t, levels, 8);
      if (round >= 10) times[index].push((performance.now() - start) / 5);
    }
  }
  console.log(
    JSON.stringify({
      levels: levels.length,
      baselineMs: times[0],
      candidateMs: times[1],
    }),
  );
}
