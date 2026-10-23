// Time a backfill of the live layer from a long span of soundings, as after a new store
// or a settings change that clears the cells, from each kind of source.
//
//   npm run build && node scripts/bench-backfill.mjs [days] [sqlite|history] [log]
//
// The soundings are synthetic, one a second at 6 kn, wandering a degree square, or with
// a plugin's SQLite log given, its soundings played one a second over and over, as a
// boat that keeps to its home waters. The log is read into memory whole, so give it a
// short one, such as ten days. The
// History source is the plugin's HTTP client against a stand-in server in a child
// process that makes rows up as fast as it can, so its numbers are the plugin's side of
// the request; the provider's own query time comes on top.
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";

const START = Date.parse("2024-01-01T00:00:00Z");
const LON = -76.5;
const LAT = 37.5;

const log = process.argv[4]
  ? new DatabaseSync(process.argv[4], { readOnly: true })
      .prepare(
        "SELECT longitude AS lon, latitude AS lat, depth FROM bathymetry ORDER BY timestamp",
      )
      .all()
  : undefined;

/** Where the boat is at second `s`: slow sinusoids, so any window can be made alone. */
function at(s) {
  if (log) return log[s % log.length];
  const lon =
    LON +
    0.3 * Math.sin(s / 9000) +
    0.15 * Math.sin(s / 1300 + 1) +
    0.04 * Math.sin(s / 170);
  const lat =
    LAT +
    0.3 * Math.cos(s / 11000) +
    0.15 * Math.sin(s / 1700) +
    0.04 * Math.cos(s / 230);
  const depth =
    3 + 10 * (0.5 + 0.5 * Math.sin(lon * 400) * Math.cos(lat * 300));
  return { lon, lat, depth: depth + Math.sin(s * 7.3) * 0.15 };
}

// The stand-in History API: `serve` as the child process's argument.
if (process.argv[5] === "serve") {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.endsWith("/contexts")) return res.end("[]");
    const from = Date.parse(url.searchParams.get("from"));
    const to = Date.parse(url.searchParams.get("to"));
    const step = Number(url.searchParams.get("resolution")) * 1000;
    const paths = url.searchParams.get("paths").split(",");
    const data = [];
    for (let t = from; t <= to; t += step) {
      const p = at((t - START) / 1000);
      const row = [new Date(t).toISOString()];
      for (const path of paths) {
        if (path.startsWith("navigation.position")) row.push([p.lon, p.lat]);
        else if (path.startsWith("environment.depth")) row.push(p.depth);
        else row.push(path.includes("speed") ? 3.1 : 1.2);
      }
      data.push(row);
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        context: "vessels.self",
        range: {
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
        },
        values: paths.map((p) => {
          const [path, method] = p.split(":");
          return { path, method };
        }),
        data,
      }),
    );
  });
  server.listen(0, () => process.send(server.address().port));
} else {
  await bench();
}

async function bench() {
  const { createDB } = await import("../dist/storage.js");
  const { createSqliteSource } = await import("../dist/sources/sqlite.js");
  const { createHistorySource } = await import("../dist/sources/history.js");
  const { createCellStore, backfillCells } =
    await import("../dist/tiles/index.js");

  const days = Number(process.argv[2] || 365);
  const kind = process.argv[3] || "sqlite";
  const seconds = days * 86400;
  const dir = mkdtempSync(join(tmpdir(), "bench-backfill-"));
  const file = join(dir, "bathymetry.sqlite");
  const db = createDB(file);
  const app = {
    debug: () => {},
    error: console.error,
    getPath: () => undefined,
    getSelfPath: () => undefined,
    getHistoryApi: () => Promise.reject(new Error("none")),
  };
  const config = {
    path: "belowTransducer",
    sounder: { x: 0, y: 2, z: 0 },
    gnss: { x: 0, y: 0, z: 0 },
    sharing: { anonymous: true },
  };

  let source;
  let child;
  if (kind === "sqlite") {
    const t0 = performance.now();
    const insert = db.prepare(
      "INSERT INTO bathymetry(longitude, latitude, depth, timestamp, heading) VALUES(?, ?, ?, ?, ?)",
    );
    db.exec("BEGIN");
    for (let s = 0; s < seconds; s++) {
      const p = at(s);
      insert.run(p.lon, p.lat, p.depth, START + s * 1000, 1.2);
      if (s % 1_000_000 === 999_999) db.exec("COMMIT; BEGIN");
    }
    db.exec("COMMIT");
    console.log(
      `log: ${seconds} soundings, ${(statSync(file).size / 1e6).toFixed(0)} MB, written in ${((performance.now() - t0) / 1000).toFixed(0)} s`,
    );
    source = createSqliteSource(app, db);
  } else {
    child = fork(new URL(import.meta.url).pathname, [
      ...[2, 3, 4].map((i) => process.argv[i] ?? ""),
      "serve",
    ]);
    const port = await new Promise((r) => child.once("message", r));
    source = await createHistorySource(app, config, {
      host: `http://127.0.0.1:${port}/`,
    });
    // Each read's time on its own: the request and the JSON, without the cells.
    const reader = source.createReader.bind(source);
    let reading = 0;
    source.createReader = async (window) => {
      const t = performance.now();
      const r = await reader(window);
      reading += performance.now() - t;
      return r;
    };
    source.readingMs = () => reading;
  }

  const store = createCellStore(db);
  const from = Temporal.Instant.fromEpochMilliseconds(START);
  const to = Temporal.Instant.fromEpochMilliseconds(START + seconds * 1000);
  store.setMeta("backfill", `${from}/${to}`);

  const base = process.memoryUsage().rss;
  let peak = 0;
  const sample = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 200);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const t0 = performance.now();
  await backfillCells({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
    file,
    until: to,
  });
  const s = (performance.now() - t0) / 1000;
  loop.disable();
  clearInterval(sample);
  const cells = db.prepare("SELECT count(*) AS n FROM cells").get().n;
  console.log(
    `backfill (${kind}, ${days} days): ${s.toFixed(0)} s, ${Math.round(seconds / s)} soundings/s, ` +
      `${cells} cells; peak RSS ${(peak / 1e6).toFixed(0)} MB, ${((peak - base) / 1e6).toFixed(0)} MB over the start (this thread and the worker); ` +
      `event loop held at most ${(loop.max / 1e6).toFixed(0)} ms, p99 ${(loop.percentile(99) / 1e6).toFixed(0)} ms` +
      (source.readingMs
        ? `; reads ${(source.readingMs() / 1000).toFixed(0)} s of it`
        : ""),
  );
  child?.kill();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
