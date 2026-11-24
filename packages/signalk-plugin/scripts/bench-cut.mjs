// After building: node scripts/bench-cut.mjs /baseline/dist/tiles/portray.js
// Exact field parity, then twenty alternating timings after five warm-up rounds.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as b from "../dist/tiles/portray.js";
if (!process.argv[2])
  throw new Error("provide the preceding build's portrayal module");
const a = await import(pathToFileURL(resolve(process.argv[2])).href);
for (const n of [64, 208, 256])
  for (const fraction of [0.1, 1]) {
    const w = n + 10,
      p = {
        w,
        depth: new Float64Array(w * w).fill(NaN),
        wet: new Float64Array(w * w).fill(NaN),
        extent: new Float64Array(w * w).fill(-10),
        measured: new Float64Array(w * w).fill(-10),
        shoal: new Float64Array(w * w).fill(Infinity),
        window: [5, 5, Math.floor(n * fraction) + 4, n + 4],
      };
    for (let y = 5; y < n + 5; y++)
      for (let x = 5; x <= p.window[2]; x++) {
        const i = y * w + x;
        p.depth[i] = p.wet[i] = i % 19;
        p.extent[i] = p.measured[i] = 1;
      }
    const aa = a.cut(p, 0, 0, n, 1),
      bb = b.cut(p, 0, 0, n, 1);
    for (const field of [
      "depth",
      "wet",
      "extent",
      "measured",
      "depthSlope",
      "wetSlope",
    ])
      assert.deepEqual(aa[field], bb[field]);
    const times = [[], []];
    for (let r = 0; r < 25; r++)
      for (const k of r % 2 ? [1, 0] : [0, 1]) {
        const t = performance.now();
        [a, b][k].cut(p, 0, 0, n, 1);
        if (r >= 5) times[k].push(performance.now() - t);
      }
    console.log(
      JSON.stringify({ n, fraction, baseline: times[0], candidate: times[1] }),
    );
  }
