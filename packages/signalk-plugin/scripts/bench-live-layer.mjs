// Time the live layer on this machine: the writer's throughput, and cold tiles from a
// store as large as the busiest vessel in the Chesapeake set (1.48M cells).
//
//   npm run build && node scripts/bench-live-layer.mjs [cells]
//
// The tracks are synthetic: random-walk lanes at 6 kn, a sounding every 10 s, over
// one degree square, until the store holds that many cells.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../dist/storage.js";
import {
  createCellStore,
  createCellWriter,
  createWorkerSink,
} from "../dist/tiles/index.js";
import { createTileService } from "../dist/tiles/service.js";
import { tileFraction } from "../dist/tiles/geometry.js";

const target = Number(process.argv[2] ?? 1_480_000);
const dir = mkdtempSync(join(tmpdir(), "bench-live-"));
const file = join(dir, "bathymetry.sqlite");
const db = createDB(file);
const store = createCellStore(db);

let seed = 1;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const LON = -76.5;
const LAT = 37.5;
let time = Temporal.Instant.from("2020-01-01T00:00:00Z").epochMilliseconds;

async function lane(n, writer) {
  let lon = LON + random() - 0.5;
  let lat = LAT + random() - 0.5;
  let heading = random() * 2 * Math.PI;
  for (let i = 0; i < n; i++) {
    heading += (random() - 0.5) * 0.2;
    lat += (Math.cos(heading) * 31) / 110540;
    lon +=
      (Math.sin(heading) * 31) / (111320 * Math.cos((lat * Math.PI) / 180));
    lon = Math.min(LON + 0.5, Math.max(LON - 0.5, lon));
    lat = Math.min(LAT + 0.5, Math.max(LAT - 0.5, lat));
    time += 10_000;
    const depth =
      3 + 10 * (0.5 + 0.5 * Math.sin(lon * 400) * Math.cos(lat * 300));
    if (
      !writer.write({
        longitude: lon,
        latitude: lat,
        depth: depth + (random() - 0.5) * 0.3,
        timestamp: Temporal.Instant.fromEpochMilliseconds(time),
      })
    )
      await new Promise((r) => writer.once("drain", r));
  }
  time += 6 * 3600_000;
}

const count = () => db.prepare("SELECT count(*) AS n FROM cells").get().n;

// Writer throughput on a first slice, as a live writer and as a backfill.
for (const bulk of [false, true]) {
  const writer = createCellWriter(store, { bulk, flushIntervalMs: 10_000 });
  const t0 = performance.now();
  await lane(100_000, writer);
  await new Promise((r) => writer.end(r));
  const s = (performance.now() - t0) / 1000;
  console.log(
    `writer (${bulk ? "backfill" : "live"}): ${Math.round(100_000 / s)} soundings/s`,
  );
}

// Fill to the target as a backfill does, on its worker thread, and watch the event loop
// the server would run on.
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const fill0 = performance.now();
let soundings = 200_000;
while (count() < target) {
  const writer = createWorkerSink(file);
  for (let i = 0; i < 20; i++) {
    await lane(5000, writer);
    await setImmediate();
  }
  await new Promise((r) => writer.end(r));
  soundings += 100_000;
}
const fillS = (performance.now() - fill0) / 1000;
loop.disable();
console.log(
  `store: ${count()} cells from ${soundings} soundings, ${(statSync(file).size / 1e6).toFixed(0)} MB; ` +
    `filled at ${Math.round((soundings - 200_000) / fillS)} soundings/s, ` +
    `event loop held at most ${(loop.max / 1e6).toFixed(0)} ms`,
);

// Cold tiles over the middle of the tracks, each zoom, built on the worker thread.
const tiles = createTileService(store, file);
for (const z of [15, 14, 13, 12, 11, 10, 8, 6]) {
  const f = tileFraction(LON, LAT, z);
  const times = [];
  let bytes = 0;
  for (let i = 0; i < 3; i++) {
    tiles.reset();
    const t0 = performance.now();
    bytes = (await tiles.get(z, Math.floor(f.x), Math.floor(f.y)))?.length ?? 0;
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(
    `z${z}: ${times[1].toFixed(0)} ms cold, ${(bytes / 1024).toFixed(1)} KB`,
  );
}
// A view's worth of z13 tiles at once, and the longest the event loop waited meanwhile.
const view = monitorEventLoopDelay({ resolution: 10 });
view.enable();
tiles.reset();
const f13 = tileFraction(LON, LAT, 13);
const v0 = performance.now();
await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    tiles.get(
      13,
      Math.floor(f13.x) + (i % 5) - 2,
      Math.floor(f13.y) + Math.floor(i / 5) - 2,
    ),
  ),
);
view.disable();
console.log(
  `20 z13 tiles: ${(performance.now() - v0).toFixed(0)} ms, event loop held at most ${(view.max / 1e6).toFixed(0)} ms`,
);
tiles.close();
db.close();
rmSync(dir, { recursive: true, force: true });
