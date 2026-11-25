// Actual owned store, including worker IPC, compression, FULL commits and spatial reads.
// node scripts/bench-observations.mjs <fixture-parent> [points=10000] [health-url]
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { createObservationStore } from "../dist/observations/client.js";
const [parent, countArg = "10000", healthUrl, paceArg = "5"] =
  process.argv.slice(2);
const count = Number(countArg);
const paceMs = Number(paceArg);
if (!Number.isFinite(paceMs) || paceMs < 0 || paceMs > 10000)
  throw Error("pace must be 0..10000 ms");
function written() {
  try {
    return Number(
      readFileSync("/proc/self/io", "utf8").match(/^write_bytes: (\d+)$/m)[1],
    );
  } catch {
    return null;
  }
}
const ioStart = written();
if (!parent || !Number.isInteger(count) || count < 100 || count > 1000000)
  throw Error(
    "usage: bench-observations.mjs <fixture-parent> [points=100..1000000] [health-url]",
  );
const dir = mkdtempSync(join(parent, "observation-benchmark-"));
const file = join(dir, "observations.sqlite");
const size = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};
const store = createObservationStore(file);
const lag = monitorEventLoopDelay({ resolution: 10 });
const health = [],
  writes = [];
let done = false,
  peakWalBytes = 0,
  encodedInputBytes = 0;
const probes = healthUrl
  ? (async () => {
      while (!done) {
        const begin = performance.now();
        try {
          const response = await fetch(healthUrl, {
            signal: AbortSignal.timeout(3000),
          });
          await response.arrayBuffer();
          health.push({
            status: response.status,
            ms: performance.now() - begin,
          });
        } catch (error) {
          health.push({ error: String(error), ms: performance.now() - begin });
        }
        if (!done) await sleep(250);
      }
    })()
  : Promise.resolve();
const context = {
  kind: "live",
  depthPath: "environment.depth.belowTransducer",
  settings: { sounder: { z: 0.3 }, gnss: { x: 0, y: 4 } },
};
const start = Date.UTC(2026, 0, 1);
let last;
lag.enable();
try {
  const init = performance.now();
  await store.ready;
  const startupMs = performance.now() - init;
  const begin = performance.now();
  // Fifty samples model ten seconds at 5 Hz; accelerated acquisition exposes commit cost.
  for (let offset = 0; offset < count; offset += 50) {
    const points = Array.from(
      { length: Math.min(50, count - offset) },
      (_, j) => {
        const i = offset + j;
        return {
          timestamp: new Date(start + i * 200).toISOString(),
          longitude: -80 + Math.sin(i / 100) * 0.0001,
          latitude: 26 + Math.cos(i / 100) * 0.0001,
          depth: 3 + Math.sin(i / 10000) * 0.5,
          speedOverGround: 0.01,
          depthSource: "sounder",
          positionSource: "gps",
        };
      },
    );
    encodedInputBytes += Buffer.byteLength(JSON.stringify(points));
    const before = performance.now();
    last = await store.append(context, points, `benchmark-${offset}`);
    writes.push(performance.now() - before);
    peakWalBytes = Math.max(peakWalBytes, size(file + "-wal"));
    await sleep(paceMs);
  }
  const elapsedMs = performance.now() - begin;
  const queryStart = performance.now();
  const chunks = await store.query(
    start,
    start + count * 200,
    [-80.001, 25.999, -79.999, 26.001],
  );
  const queryMs = performance.now() - queryStart;
  assert.equal(chunks.length, Math.min(64, Math.ceil(count / 50)));
  const tail = await store.read(last.id);
  assert.equal(
    tail.points.at(-1).timestamp,
    new Date(start + (count - 1) * 200).toISOString(),
  );
  await store.close();
  done = true;
  await probes;
  const ordered = writes.toSorted((a, b) => a - b);
  console.log(
    JSON.stringify({
      count,
      paceMs,
      processWriteBytes: ioStart === null ? null : written() - ioStart,
      transactions: writes.length,
      startupMs,
      elapsedMs,
      commitP50Ms: ordered[Math.floor(ordered.length * 0.5)],
      commitP95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
      commitMaxMs: ordered.at(-1),
      queryMs,
      databaseBytes: size(file),
      peakWalBytes,
      encodedInputBytes,
      eventLoopMaxMs: lag.max / 1e6,
      health,
    }),
  );
} finally {
  done = true;
  lag.disable();
  await store.close();
  await probes;
  rmSync(dir, { recursive: true, force: true });
}
