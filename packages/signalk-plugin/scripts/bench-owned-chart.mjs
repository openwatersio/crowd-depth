// Owned history -> chart correction -> QC worker -> cells -> tile worker.
// Synthetic provider latency is excluded. Does not measure browser paint.
// node scripts/bench-owned-chart.mjs <fixture-parent> [hz=5] [overlap]
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Temporal } from "@js-temporal/polyfill";
import { createObservationStore } from "../dist/observations/client.js";
import { storedHistorySource } from "../dist/observations/source.js";
import { createDB } from "../dist/storage.js";
import { createCellStore } from "../dist/tiles/cells.js";
import { refineHistory } from "../dist/tiles/refine.js";
import { createTileService } from "../dist/tiles/service.js";
import { tileFraction } from "../dist/tiles/geometry.js";
import { Timeframe } from "../dist/types.js";

const [parent, hzArg = "5", variant] = process.argv.slice(2);
const overlap = variant === "overlap";
const hz = Number(hzArg);
assert(
  parent &&
    Number.isInteger(hz) &&
    hz >= 1 &&
    hz <= 10 &&
    (variant === undefined || overlap),
  "usage: bench-owned-chart.mjs <fixture-parent> [hz=1..10] [overlap]",
);
const dir = mkdtempSync(join(parent, "owned-chart-benchmark-"));
const start = Date.UTC(2026, 0, 1);
const hour = 3600000;
const window = new Timeframe(
  Temporal.Instant.fromEpochMilliseconds(start),
  Temporal.Instant.fromEpochMilliseconds(start + hour),
);
const config = {
  path: "belowTransducer",
  sounder: { x: 0, y: 2, z: 0.3 },
  gnss: { x: 0, y: 6, z: 2 },
};
let archive;
try {
  for (const scenario of ["anchored", "underway"]) {
    archive = createObservationStore(
      join(dir, `${scenario}-observations.sqlite`),
    );
    let providerCalls = 0;
    let providerDisabled = false;
    const provider = {
      createReader() {
        throw Error("unexpected corrected provider read");
      },
      getAvailableTimeframes() {
        throw Error("explicit work should not discover history");
      },
      createObservationReader(span) {
        assert(
          !providerDisabled,
          "rebuild contacted provider instead of owned observations",
        );
        providerCalls++;
        return Readable.from(
          (function* () {
            for (let i = 0; i < 3600 * hz; i++) {
              const time = start + (i * 1000) / hz;
              if (
                time < span.from.epochMilliseconds ||
                time >= span.to.epochMilliseconds
              )
                continue;
              const s = i / hz;
              yield {
                timestamp: new Date(time).toISOString(),
                longitude:
                  -80 +
                  (scenario === "anchored"
                    ? Math.sin(s / 300) * 0.0001
                    : s * 0.00001),
                latitude: 26 + Math.cos(s / 300) * 0.0001,
                depth: 5 + 0.2 * Math.sin(s / 700) + 0.01 * Math.sin(s * 0.7),
                headingTrue: 1.2,
                speedOverGround: scenario === "anchored" ? 0.01 : 1,
                depthSource: "sounder.1",
                positionSource: "gps.1",
              };
            }
          })(),
        );
      },
    };
    let expectedCells;
    for (const phase of ["first-import", "owned-rebuild"]) {
      if (phase === "owned-rebuild") {
        await archive.close();
        archive = createObservationStore(
          join(dir, `${scenario}-observations.sqlite`),
        );
        providerDisabled = true;
      }
      const source = storedHistorySource(
        archive,
        provider,
        config,
        new AbortController().signal,
      );
      let seedMs = 0;
      if (overlap && phase === "first-import") {
        const startSeed = performance.now();
        await (
          await source.createPreviewReader(
            new Timeframe(
              window.from.add({ minutes: 23 }),
              window.to.add({ minutes: 23 }),
            ),
          )
        ).toArray();
        seedMs = performance.now() - startSeed;
      }
      const file = join(dir, `${scenario}-${phase}-chart.sqlite`);
      const db = createDB(file);
      const cells = createCellStore(db);
      const tiles = createTileService(cells, file, "high");
      const lag = monitorEventLoopDelay({ resolution: 10 });
      lag.enable();
      let firstCommitMs;
      const begin = performance.now();
      try {
        await refineHistory({
          source,
          config,
          store: cells,
          file,
          signal: AbortSignal.timeout(120000),
          windows: [window],
          onChange(changed) {
            if (changed.length) firstCommitMs ??= performance.now() - begin;
            tiles.changed(changed);
          },
          onError(error) {
            throw error;
          },
        });
        const refineMs = performance.now() - begin;
        const result = cells.cells(-80.01, 25.99, -79.95, 26.01);
        assert(result.length > 0, "fixture produced no chart cells");
        if (expectedCells) assert.deepEqual(result, expectedCells);
        else expectedCells = result;
        const f = tileFraction(-80, 26, 15);
        const tileStart = performance.now();
        const tile = await tiles.get(15, Math.floor(f.x), Math.floor(f.y));
        assert(tile?.length, "fixture produced no visible tile");
        console.log(
          JSON.stringify({
            scenario,
            phase,
            overlap,
            seedMs,
            hz,
            observations: 3600 * hz,
            providerCalls,
            firstCommitMs,
            refineMs,
            tileMs: performance.now() - tileStart,
            totalMs: performance.now() - begin,
            cells: result.length,
            tileBytes: tile.length,
            eventLoopMaxMs: lag.max / 1e6,
            rssBytes: process.memoryUsage().rss,
          }),
        );
      } finally {
        lag.disable();
        await tiles.close();
        db.close();
      }
    }
    await archive.close();
    archive = undefined;
  }
} finally {
  await archive?.close();
  rmSync(dir, { recursive: true, force: true });
}
