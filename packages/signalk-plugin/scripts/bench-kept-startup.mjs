// Cache upgrade on an isolated copy, preserving the source database.
// node scripts/bench-kept-startup.mjs database [write-hz=0..10]
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createDB, withoutBusyWait, isBusy } from "../dist/storage.js";
import { prepareKeptTiles } from "../dist/tiles/kept.js";

const [sourceFile, rateArg = "0"] = process.argv.slice(2);
const rate = Number(rateArg);
if (!sourceFile || !Number.isFinite(rate) || rate < 0 || rate > 10)
  throw new Error("usage: bench-kept-startup.mjs database [write-hz=0..10]");
const dir = mkdtempSync(join(tmpdir(), "crowd-depth-cache-bench-"));
const file = join(dir, "copy.sqlite");
let db;
let timer;
let running;
const stop = new AbortController();
const loop = monitorEventLoopDelay({ resolution: 10 });
try {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, file);
  } finally {
    source.close();
  }
  db = createDB(file);
  const count = () =>
    Number(db.prepare("SELECT count(*) n FROM cells").get().n);
  const before = count();
  const oldTiles = Number(
    db.prepare("SELECT count(*) n FROM kept_tiles").get().n,
  );
  db.prepare(
    "INSERT OR REPLACE INTO tile_meta VALUES('kept_tiles_version','benchmark-previous-build')",
  ).run();
  const write = db.prepare(
    "INSERT OR REPLACE INTO tile_meta VALUES('benchmark_tick','1')",
  );
  const writes = [];
  let busy = 0;
  let failure;
  if (rate)
    timer = setInterval(() => {
      const start = performance.now();
      try {
        withoutBusyWait(db, () => write.run());
        writes.push(performance.now() - start);
      } catch (error) {
        if (isBusy(error)) busy++;
        else failure = String(error);
      }
    }, 1000 / rate);
  loop.enable();
  const start = performance.now();
  running = prepareKeptTiles(db, "high", stop.signal);
  const synchronousMs = performance.now() - start;
  await running;
  const totalMs = performance.now() - start;
  assert.equal(count(), before, "canonical cells changed");
  const remaining = Number(
    db.prepare("SELECT count(*) n FROM kept_tiles").get().n,
  );
  assert.equal(remaining, 0, "old renderer tiles survived");
  assert.equal(failure, undefined);
  console.log(
    JSON.stringify({
      oldTiles,
      cells: before,
      synchronousMs,
      totalMs,
      remaining,
      journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
      writeHz: rate,
      writes: writes.length,
      busy,
      maxWriteMs: Math.max(0, ...writes),
      eventLoopMaxMs: loop.max / 1e6,
      eventLoopP99Ms: loop.percentile(99) / 1e6,
    }),
  );
} finally {
  clearInterval(timer);
  stop.abort();
  await running?.catch(() => {});
  loop.disable();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
}
