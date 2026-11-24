// Run after npm run build -w crowd-depth. A synthetic comparison, not a Pi latency promise.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../dist/storage.js";
import {
  createPreviewStore,
  scanPreview,
} from "../dist/tiles/history-preview.js";
import { createCellStore } from "../dist/tiles/cells.js";
import { createCellWriter } from "../dist/tiles/writer.js";

const count = Number(process.argv[2] ?? 20000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000000)
  throw new Error("count must be 1..1000000");
const until = Date.parse("2026-10-16T12:00:00Z");
const config = { sounder: { x: 0, y: 0 }, gnss: { x: 0, y: 0 } };
for (const moving of [true, false]) {
  const dir = mkdtempSync(join(tmpdir(), "crowd-depth-preview-bench-"));
  const db = createDB(join(dir, "bench.sqlite"));
  let preview;
  const samples = function* () {
    for (let i = 0; i < count; i++)
      yield {
        longitude: -80 + (moving ? i * 0.00001 : 0),
        latitude: 26,
        depth: 6 + 0.1 * Math.sin(i / 20),
        timestamp: Temporal.Instant.fromEpochMilliseconds(
          until - 3600000 + Math.floor((i * 3600000) / count),
        ),
      };
  };
  try {
    preview = createPreviewStore(db, "benchmark");
    const original = preview.writeAsync;
    const started = performance.now();
    let first;
    preview.writeAsync = async (...args) => {
      await original(...args);
      if (args[1].length) first ??= performance.now() - started;
    };
    await scanPreview({
      source: {
        createReader: () => Readable.from(samples()),
        getAvailableTimeframes: () => [],
      },
      store: preview,
      config,
      signal: new AbortController().signal,
      until,
      since: until - 3600000,
    });
    const previewMs = performance.now() - started;
    const cells = createCellStore(db);
    const refinedStart = performance.now();
    let refinedFirst;
    await pipeline(
      Readable.from(samples()),
      createCellWriter(cells, {
        bulk: true,
        overviews: true,
        onChange: () => (refinedFirst ??= performance.now() - refinedStart),
      }),
    );
    console.log(
      JSON.stringify({
        moving,
        samples: count,
        previewFirstCommitMs: Math.round(first ?? 0),
        previewTotalMs: Math.round(previewMs),
        refinedFirstCommitMs: Math.round(refinedFirst ?? 0),
        refinedTotalMs: Math.round(performance.now() - refinedStart),
        rssMB: Math.round(process.memoryUsage().rss / 1e6),
      }),
    );
  } finally {
    await preview?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
