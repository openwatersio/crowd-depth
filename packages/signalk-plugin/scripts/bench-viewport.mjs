// Read-only, request-driven rendering through the production worker pool.
// node scripts/bench-viewport.mjs <database> <longitude> <latitude> [rounds=3] [health-url]
// No persistent tile cache; round 0 includes worker startup, later rounds retain
// workers but clear tiles and prepared surfaces. OS file caches are not flushed.
import { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createCellStore } from "../dist/tiles/cells.js";
import { createTileService } from "../dist/tiles/service.js";
import { tileFraction } from "../dist/tiles/geometry.js";

const [file, lonArg, latArg, roundsArg = "3", healthUrl] =
  process.argv.slice(2);
const lon = Number(lonArg),
  lat = Number(latArg),
  rounds = Number(roundsArg);
if (
  !file ||
  !Number.isFinite(lon) ||
  !Number.isFinite(lat) ||
  Math.abs(lon) > 180 ||
  Math.abs(lat) > 85 ||
  !Number.isInteger(rounds) ||
  rounds < 1 ||
  rounds > 20
)
  throw new Error(
    "usage: bench-viewport.mjs <database> <longitude> <latitude> [rounds=1..20] [health-url]",
  );
if (healthUrl && !["http:", "https:"].includes(new URL(healthUrl).protocol))
  throw new Error("health-url must be HTTP(S)");
const db = new DatabaseSync(file, { readOnly: true });
const service = createTileService(createCellStore(db), file, "high");
const health = [];
let stopped = false;
const probes = healthUrl
  ? (async () => {
      while (!stopped) {
        const start = performance.now();
        try {
          const response = await fetch(healthUrl, {
            signal: AbortSignal.timeout(3000),
          });
          await response.arrayBuffer();
          health.push({
            ms: performance.now() - start,
            status: response.status,
          });
        } catch (error) {
          health.push({ ms: performance.now() - start, error: String(error) });
        }
        if (!stopped) await sleep(250);
      }
    })()
  : Promise.resolve();
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
try {
  for (let round = 0; round < rounds; round++) {
    for (const z of [13, 14, 15]) {
      service.reset();
      const f = tileFraction(lon, lat, z),
        n = 2 ** z;
      const ids = Array.from({ length: 9 }, (_, i) => [
        z,
        (Math.floor(f.x) + (i % 3) - 1 + n) % n,
        Math.max(0, Math.min(n - 1, Math.floor(f.y) + Math.floor(i / 3) - 1)),
      ]);
      const start = performance.now();
      let firstVisibleMs;
      let timer;
      try {
        const results = await Promise.race([
          Promise.all(
            ids.map(async (id) => {
              const bytes = (await service.get(...id))?.length ?? 0;
              const ms = performance.now() - start;
              if (bytes) firstVisibleMs ??= ms;
              return { id, ms, bytes };
            }),
          ),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("viewport exceeded 30 seconds")),
              30000,
            );
          }),
        ]);
        const coldMs = performance.now() - start;
        const warmStart = performance.now();
        await Promise.all(ids.map((id) => service.get(...id)));
        console.log(
          JSON.stringify({
            round,
            z,
            firstVisibleMs,
            coldMs,
            warmMs: performance.now() - warmStart,
            results,
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }
} finally {
  stopped = true;
  service.close();
  db.close();
  await probes;
  loop.disable();
  console.log(
    JSON.stringify({
      eventLoopMaxMs: loop.max / 1e6,
      eventLoopP99Ms: loop.percentile(99) / 1e6,
      health,
    }),
  );
}
