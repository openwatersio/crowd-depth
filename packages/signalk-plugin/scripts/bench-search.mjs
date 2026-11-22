// Run after building, optionally with the previous build's dist/tiles/surface.js:
// node scripts/bench-search.mjs [/absolute/path/to/baseline/surface.js]
// Includes setup; one untimed warm-up and five alternating-order rounds per case.
// Checks sampled queries against a full search outside all timed rounds. These
// are kernel measurements, not viewport or Pi acceptance results.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as candidate from "../dist/tiles/surface.js";

const variants = process.argv[2]
  ? [
      ["baseline", await import(pathToFileURL(resolve(process.argv[2])).href)],
      ["candidate", candidate],
    ]
  : [["candidate", candidate]];
const radius = 200,
  max = 12;
for (const spacing of [
  1,
  3,
  4,
  5.6,
  5.7,
  10,
  "track",
  "harbour",
  "patch8",
  "patch9",
  "patch15",
  "high-latitude",
]) {
  const size =
    spacing === "high-latitude"
      ? 206
      : spacing === "harbour" || String(spacing).startsWith("patch")
        ? 284
        : 256;
  const pm = spacing === "high-latitude" ? 9.55 : size === 284 ? 27.3 : 15;
  const points = [];
  let x0 = 0,
    y0 = 0,
    x1 = size - 1,
    y1 = size - 1;
  if (spacing === "high-latitude") {
    for (let y = 0; y < 19; y++)
      for (let x = 0; x < 19; x++)
        points.push({ x: 70 + x * 2.13, y: 70 + y * 2.13 });
    x0 = y0 = 49;
    x1 = y1 = 130;
  } else if (String(spacing).startsWith("patch")) {
    const count = Number(String(spacing).slice(5));
    for (let by = 104; by < 144; by += 8)
      for (let bx = 104; bx < 144; bx += 8)
        for (let i = 0; i < count; i++)
          points.push({
            x: bx + (i % 8) + 0.25,
            y: by + Math.floor(i / 8) + 0.25,
          });
    x0 = y0 = 96;
    x1 = y1 = 151;
  } else if (spacing === "track") {
    for (let y = 0; y < size; y++) points.push({ x: 128.25, y: y + 0.25 });
    x0 = 114;
    x1 = 142;
  } else if (spacing === "harbour") {
    for (let y = 100; y < 140; y++)
      for (let x = 100; x < 140; x++) points.push({ x: x + 0.25, y: y + 0.25 });
    x0 = y0 = 92;
    x1 = y1 = 147;
  } else {
    for (let y = 0; y < size; y += spacing)
      for (let x = 0; x < size; x += spacing)
        points.push({ x: x + 0.25, y: y + 0.25 });
  }
  const run = (search, out) => {
    let found = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        search(x, y, out);
        found += out.n;
      }
    }
    return found;
  };
  for (const [, module] of variants)
    run(
      module.nearestSearch(points, size, pm, radius, max),
      module.neighbours(max),
    );
  const measured = [];
  let expectedFound;
  for (let round = 0; round < 5; round++) {
    for (const [variant, module] of round % 2
      ? [...variants].reverse()
      : variants) {
      const start = performance.now();
      const search = module.nearestSearch(points, size, pm, radius, max);
      const setupMs = performance.now() - start;
      const out = module.neighbours(max);
      const queryStart = performance.now();
      const found = run(search, out);
      const queryMs = performance.now() - queryStart;
      expectedFound ??= found;
      assert.equal(found, expectedFound);
      measured.push({ variant, round, search, out, setupMs, queryMs, found });
    }
  }
  // Validate after every timing so oracle allocation cannot bias the next variant.
  for (const {
    variant,
    round,
    search,
    out,
    setupMs,
    queryMs,
    found,
  } of measured) {
    for (let q = 0; q < 25; q++) {
      const px =
        q === 1 ? Math.floor((x0 + x1) / 2) : x0 + ((q * 37) % (x1 - x0 + 1));
      const py =
        q === 1 ? Math.floor((y0 + y1) / 2) : y0 + ((q * 61) % (y1 - y0 + 1));
      const expected = points
        .map((p, j) => ({
          j,
          d2: ((p.x - (px + 0.5)) * pm) ** 2 + ((p.y - (py + 0.5)) * pm) ** 2,
          b: Math.floor(p.y) * size + Math.floor(p.x),
        }))
        .filter((p) => p.d2 <= radius * radius)
        .sort((a, b) => a.d2 - b.d2 || a.b - b.b)
        .slice(0, max);
      search(px, py, out);
      assert.deepEqual(
        [...out.j.subarray(0, out.n)],
        expected.map((p) => p.j),
      );
      assert.deepEqual(
        [...out.d2.subarray(0, out.n)],
        expected.map((p) => p.d2),
      );
    }
    console.log(
      JSON.stringify({
        variant,
        spacing,
        round,
        points: points.length,
        queries: (y1 - y0 + 1) * (x1 - x0 + 1),
        setupMs,
        queryMs,
        found,
        sampledQueriesChecked: 25,
      }),
    );
  }
}
