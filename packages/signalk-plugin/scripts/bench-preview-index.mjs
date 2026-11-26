// Read source data only; build and query a separate database. Use an explicit
// unused output path to measure SD-card writes; otherwise the copy is in memory.
// node scripts/bench-preview-index.mjs source.sqlite [limit=100000] [output.sqlite]
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { setPriority } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { createDB } from "../dist/storage.js";
import { createPreviewStore } from "../dist/tiles/history-preview.js";
import { createCellStore } from "../dist/tiles/cells.js";
const [file, limitArg = "100000", output = ":memory:"] = process.argv.slice(2);
const limit = Number(limitArg);
if (!file || !Number.isInteger(limit) || limit < 1 || limit > 500000)
  throw new Error(
    "usage: bench-preview-index.mjs source.sqlite [limit=1..500000] [unused-output.sqlite]",
  );
if (output !== ":memory:" && existsSync(output))
  throw new Error("Output must not already exist");
if (process.platform === "linux") {
  try {
    setPriority(10);
  } catch {}
}
const source = new DatabaseSync(file, { readOnly: true });
const db = createDB(output);
const started = performance.now(),
  store = createPreviewStore(db, "benchmark");
const startupMs = performance.now() - started;
try {
  const insert = db.prepare("INSERT INTO refined_windows VALUES(?,?)");
  db.exec("BEGIN");
  if (
    source
      .prepare("SELECT 1 FROM sqlite_master WHERE name='refined_windows'")
      .get()
  )
    for (const r of source
      .prepare("SELECT start,end FROM refined_windows")
      .iterate())
      insert.run(r.start, r.end);
  db.exec("COMMIT");
  const writes = [];
  let batch = [],
    copied = 0;
  const write = async () => {
    const t = performance.now();
    await store.writeAsync("history", batch);
    writes.push(performance.now() - t);
    copied += batch.length;
    batch = [];
  };
  for (const row of source
    .prepare(
      "SELECT lon,lat,depth,time FROM preview_cells ORDER BY time,py,px LIMIT ?",
    )
    .iterate(limit)) {
    batch.push(row);
    if (batch.length === 500) {
      await write();
      await sleep(25);
    }
  }
  if (batch.length) await write();
  source.close();
  const measure = async (label) => {
    const times = [],
      counts = [];
    for (let i = 0; i < 30; i++) {
      const t = performance.now();
      counts.push(store.features([8, -180, -85, 180, 85], 0).length);
      times.push(performance.now() - t);
      await sleep(25);
    }
    const sorted = times.toSorted((a, b) => a - b);
    console.log(
      JSON.stringify({
        label,
        firstMs: times[0],
        medianMs: sorted[15],
        p95Ms: sorted[28],
        maxMs: sorted[29],
        counts,
      }),
    );
  };
  await measure("current-qc");
  const cells = createCellStore(db),
    resetStart = performance.now();
  cells.clear();
  console.log(
    JSON.stringify({ label: "reset-qc", ms: performance.now() - resetStart }),
  );
  await measure("pending-qc");
  const hours = db
    .prepare(
      "SELECT DISTINCT CAST(time/3600000 AS INTEGER) AS hour FROM preview_cells ORDER BY hour",
    )
    .all()
    .map((r) => Number(r.hour));
  const selected = [
    ...new Set(
      Array.from(
        { length: Math.min(500, hours.length) },
        (_, i) =>
          hours[Math.floor((i * hours.length) / Math.min(500, hours.length))],
      ),
    ),
  ];
  for (const label of [
    "retire-distributed-hours",
    "replay-distributed-hours",
  ]) {
    const times = [];
    for (const hour of selected) {
      const t = performance.now();
      cells.replaceWindow(hour * 3600000, (hour + 1) * 3600000, [], []);
      times.push(performance.now() - t);
      await sleep(5);
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        label,
        hours: times.length,
        p95Ms: times[Math.floor(times.length * 0.95)],
        maxMs: times.at(-1),
      }),
    );
  }
  const busiest = db
    .prepare(
      "SELECT CAST(time/3600000 AS INTEGER) AS hour, count(*) AS n FROM preview_cells GROUP BY hour ORDER BY n DESC LIMIT 1",
    )
    .get();
  if (busiest) {
    cells.clear();
    const t = performance.now();
    insert.run(busiest.hour * 3600000, (busiest.hour + 1) * 3600000);
    console.log(
      JSON.stringify({
        label: "retire-hour",
        points: busiest.n,
        ms: performance.now() - t,
      }),
    );
  }
  writes.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      label: "storage",
      copied,
      startupMs,
      writeBatch: 500,
      writeMedianMs: writes[Math.floor(writes.length / 2)],
      writeP95Ms: writes[Math.floor(writes.length * 0.95)],
      writeMaxMs: writes.at(-1),
      rssBytes: process.memoryUsage().rss,
      fileBytes:
        output === ":memory:"
          ? undefined
          : [output, output + "-wal"].reduce(
              (sum, p) => sum + (existsSync(p) ? statSync(p).size : 0),
              0,
            ),
    }),
  );
} finally {
  await store.close();
  db.close();
  if (source.isOpen) source.close();
}
