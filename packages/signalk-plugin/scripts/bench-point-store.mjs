// Storage experiment, not production storage. Run each case in a fresh process.
// node scripts/bench-point-store.mjs [point-count] [NORMAL|FULL]
// stdout is JSON; no production databases are read or written.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, cpus, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { deflateSync, inflateSync } from "node:zlib";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import assert from "node:assert/strict";

const count = Number(process.argv[2] ?? 100000);
const sync = process.argv[3] ?? "NORMAL";
if (!Number.isSafeInteger(count) || count < 1000 || count > 50000000)
  throw new Error("point-count must be 1,000..50,000,000");
if (!["NORMAL", "FULL"].includes(sync))
  throw new Error("sync must be NORMAL or FULL");
const layout = process.argv[4],
  scene = process.argv[5];

function sample(i) {
  const anchor =
    scene === "anchored" || (scene === "mixed" && i % 10000 < 8000);
  const x =
    -80 + (anchor ? Math.sin(i / 13) * 0.00002 : Math.sin(i / 3000) * 0.25);
  const y =
    26 + (anchor ? Math.cos(i / 11) * 0.00002 : Math.cos(i / 4000) * 0.25);
  return [1700000000000 + i * 200, x, y, 5 + Math.sin(i / 700) * 0.5, 1.2];
}
const view = [-80.003, 25.997, -79.997, 26.003];
const inside = (p) =>
  p[1] >= view[0] && p[1] <= view[2] && p[2] >= view[1] && p[2] <= view[3];
const percentiles = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
};
function writeBytes() {
  try {
    return Number(
      readFileSync("/proc/self/io", "utf8").match(/^write_bytes: (\d+)$/m)[1],
    );
  } catch {
    return null;
  }
}
function size(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function bench() {
  const dir = mkdtempSync(join(tmpdir(), "crowd-depth-point-store-"));
  const file = join(dir, "candidate.sqlite");
  const db = new DatabaseSync(file);
  const lag = monitorEventLoopDelay({ resolution: 10 });
  let peakWalBytes = 0;
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${sync}; PRAGMA wal_autocheckpoint=1000;
      CREATE TABLE raw(id INTEGER PRIMARY KEY, time INTEGER, x REAL, y REAL, depth REAL, heading REAL);
      CREATE INDEX raw_time ON raw(time);
      CREATE TABLE chunks(id INTEGER PRIMARY KEY, start INTEGER, end INTEGER, data BLOB);
      CREATE INDEX chunk_time ON chunks(start, end);
      CREATE VIRTUAL TABLE spatial USING rtree(id, minX, maxX, minY, maxY);
      CREATE TABLE summary(id INTEGER PRIMARY KEY, cx INTEGER, cy INTEGER, n INTEGER, total REAL, UNIQUE(cx,cy));
      CREATE VIRTUAL TABLE summary_spatial USING rtree(id, minX, maxX, minY, maxY);
    `);
    const row = db.prepare("INSERT INTO raw VALUES(?,?,?,?,?,?)");
    const chunk = db.prepare("INSERT INTO chunks VALUES(?,?,?,?)");
    const bounds = db.prepare("INSERT INTO spatial VALUES(?,?,?,?,?)");
    const summary =
      db.prepare(`INSERT INTO summary(cx,cy,n,total) VALUES(?,?,?,?)
      ON CONFLICT(cx,cy) DO UPDATE SET n=n+excluded.n,total=total+excluded.total RETURNING id`);
    const summaryBounds = db.prepare(
      "INSERT OR IGNORE INTO summary_spatial VALUES(?,?,?,?,?)",
    );
    const batches = [];
    let expected = 0,
      rawInputBytes = 0;
    const ioStart = writeBytes();
    lag.enable();
    await new Promise((r) => setTimeout(r, 20));
    const started = performance.now();
    for (let offset = 0; offset < count; offset += 256) {
      const points = Array.from(
        { length: Math.min(256, count - offset) },
        (_, j) => sample(offset + j),
      );
      expected += points.filter(inside).length;
      rawInputBytes += points.length * 5 * 8;
      const begin = performance.now();
      db.exec("BEGIN IMMEDIATE");
      const bins = new Map();
      for (const [j, p] of points.entries()) {
        if (layout === "rows") {
          row.run(offset + j + 1, ...p);
          bounds.run(offset + j + 1, p[1], p[1], p[2], p[2]);
        }
        const cx = Math.floor(p[1] * 5000),
          cy = Math.floor(p[2] * 5000);
        const key = cx + ":" + cy;
        const bin = bins.get(key) ?? { cx, cy, n: 0, total: 0 };
        bin.n++;
        bin.total += p[3];
        bins.set(key, bin);
      }
      if (layout === "chunks") {
        const id = offset / 256 + 1;
        chunk.run(
          id,
          points[0][0],
          points.at(-1)[0],
          deflateSync(JSON.stringify(points)),
        );
        bounds.run(
          id,
          Math.min(...points.map((p) => p[1])),
          Math.max(...points.map((p) => p[1])),
          Math.min(...points.map((p) => p[2])),
          Math.max(...points.map((p) => p[2])),
        );
      }
      for (const bin of bins.values()) {
        const { id } = summary.get(bin.cx, bin.cy, bin.n, bin.total);
        summaryBounds.run(
          id,
          bin.cx / 5000,
          (bin.cx + 1) / 5000,
          bin.cy / 5000,
          (bin.cy + 1) / 5000,
        );
      }
      db.exec("COMMIT");
      batches.push(performance.now() - begin);
      peakWalBytes = Math.max(peakWalBytes, size(file + "-wal"));
      await setImmediate();
    }
    const ingestMs = performance.now() - started;
    const sqlBounds =
      "s.maxX >= ? AND s.minX <= ? AND s.maxY >= ? AND s.minY <= ?";
    const params = [view[0], view[2], view[1], view[3]];
    const rawQuery =
      layout === "rows"
        ? db.prepare(`SELECT count(*) n FROM spatial s JOIN raw p ON p.id=s.id WHERE ${sqlBounds}
          AND p.x>=? AND p.x<=? AND p.y>=? AND p.y<=?`)
        : db.prepare(
            `SELECT c.data FROM spatial s JOIN chunks c ON c.id=s.id WHERE ${sqlBounds}`,
          );
    const summaryQuery =
      db.prepare(`SELECT p.n,p.total FROM summary_spatial s JOIN summary p ON p.id=s.id
      WHERE ${sqlBounds} LIMIT 1200`);
    const rawTimes = [],
      summaryTimes = [];
    for (let i = 0; i < 20; i++) {
      let at = performance.now(),
        actual = 0;
      if (layout === "rows") actual = rawQuery.get(...params, ...params).n;
      else
        for (const { data } of rawQuery.iterate(...params))
          actual += JSON.parse(inflateSync(data)).filter(inside).length;
      assert.equal(
        actual,
        expected,
        "spatial query must match the exact fixture count",
      );
      rawTimes.push(performance.now() - at);
      at = performance.now();
      const result = summaryQuery.all(...params);
      assert(result.length <= 1200);
      summaryTimes.push(performance.now() - at);
      await setImmediate();
    }
    const beforeCheckpoint = performance.now();
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    const checkpointMs = performance.now() - beforeCheckpoint;
    await new Promise((r) => setTimeout(r, 20));
    const ioEnd = writeBytes();
    console.log(
      JSON.stringify({
        layout,
        scene,
        count,
        sync,
        batchPoints: 256,
        node: process.version,
        sqlite: db.prepare("SELECT sqlite_version() v").get().v,
        platform: platform(),
        cpu: cpus()[0]?.model,
        ingestMs,
        transactionMs: percentiles(batches),
        rawViewportMs: percentiles(rawTimes),
        summaryViewportMs: percentiles(summaryTimes),
        matchingPoints: expected,
        databaseBytes: size(file),
        peakWalBytes,
        checkpointMs,
        numericInputBytes: rawInputBytes,
        kernelWriteBytes:
          ioStart === null || ioEnd === null ? null : ioEnd - ioStart,
        maxRssKiB: process.resourceUsage().maxRSS,
        eventLoopMaxMs: lag.max / 1e6,
        cacheState: "warm; includes writes, not an OS-cold read benchmark",
      }),
    );
  } finally {
    lag.disable();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (!layout) {
  const results = [];
  for (const kind of ["rows", "chunks"])
    for (const fixture of ["underway", "anchored", "mixed"]) {
      const run = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), String(count), sync, kind, fixture],
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        },
      );
      if (run.status !== 0) throw new Error(run.stderr || run.stdout);
      results.push(JSON.parse(run.stdout));
    }
  console.log(JSON.stringify({ prototype: true, results }, null, 2));
} else {
  await bench();
}
