// Exercise the chart's actual owned-history source, including IPC and conversion.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Temporal } from "@js-temporal/polyfill";
import { createObservationStore } from "../dist/observations/client.js";
import { storedHistorySource } from "../dist/observations/source.js";
import { Timeframe } from "../dist/types.js";
const parent = process.argv[2];
if (!parent)
  throw Error("usage: bench-observation-source.mjs <fixture-parent>");
const dir = mkdtempSync(join(parent, "owned-source-benchmark-"));
const file = join(dir, "observations.sqlite");
let store = createObservationStore(file);
const cfg = {
  path: "belowTransducer",
  sounder: { x: 0, y: 2, z: 0.3 },
  gnss: { x: 0, y: 6, z: 2 },
};
const start = Date.UTC(2026, 0, 1);
const window = new Timeframe(
  Temporal.Instant.fromEpochMilliseconds(start),
  Temporal.Instant.fromEpochMilliseconds(start + 3600000),
);
let calls = 0;
const provider = {
  createReader() {
    throw Error("unexpected corrected provider read");
  },
  getAvailableTimeframes() {
    return [window];
  },
  createObservationReader() {
    calls++;
    return Readable.from(
      Array.from({ length: calls === 1 ? 3600 : 1800 }, (_, i) => ({
        timestamp: new Date(start + i * 1000).toISOString(),
        longitude: -80 + Math.sin(i / 100) * 0.0001,
        latitude: 26 + Math.cos(i / 100) * 0.0001,
        depth: 3 + Math.sin(i / 1000) * 0.5 + (calls === 1 ? 0 : 1),
        headingTrue: 1.2,
        speedOverGround: 0.01,
        depthSource: "sounder.1",
        positionSource: "gps.1",
        gnss: {
          satellites: 12,
          horizontalDilution: 0.8,
          methodQuality: "DGNSS fix",
        },
      })),
    );
  },
};
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const measurements = [];
try {
  for (const phase of [
    "first-import",
    "warm-replay",
    "reopened-replay",
    "pruned-refresh",
  ]) {
    if (phase === "reopened-replay") {
      await store.close();
      store = createObservationStore(file);
    }
    if (phase === "pruned-refresh") {
      const first = (await store.query(start, start + 3600000))[0];
      const identity = JSON.stringify((await store.read(first.id)).acquisition);
      const receipt = await store.imported(identity, start, start + 3600000);
      await store.publishImport(
        identity,
        start,
        start + 3600000,
        receipt.chunks,
        0,
      );
    }
    const source = storedHistorySource(
      store,
      provider,
      cfg,
      new AbortController().signal,
    );
    let count = 0,
      first;
    const begin = performance.now();
    for await (const point of source.createReader(window)) {
      first ??= performance.now() - begin;
      assert(Number.isFinite(point.depth));
      count++;
    }
    const elapsedMs = performance.now() - begin;
    const query = performance.now();
    const hints = await source.getStoredTimeframes(
      window,
      [-80.001, 25.999, -79.999, 26.001],
    );
    assert.equal(hints.length, 1);
    assert.equal(count, 3600);
    assert.equal(calls, phase === "pruned-refresh" ? 2 : 1);
    measurements.push({
      phase,
      firstMs: first,
      elapsedMs,
      spatialMs: performance.now() - query,
      count,
    });
  }
  console.log(
    JSON.stringify({
      measurements,
      providerCalls: calls,
      eventLoopMaxMs: lag.max / 1e6,
    }),
  );
} finally {
  lag.disable();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
}
