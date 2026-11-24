import {
  createPreviewWriter,
  createPreviewWriteThread,
} from "./preview-write.js";
import { createPreviewQuery } from "./preview-query.js";
import {
  createPreviewSpatial,
  clearPreviewSpatial,
  disablePreviewSpatial,
  isolateDamagedPreview,
} from "./preview-spatial.js";
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { BATHY_EPOCH, BATHY_REPORT_DELAY } from "../constants.js";
import type { BathymetryData, BathymetrySource } from "../types.js";
import { Timeframe } from "../types.js";
import { correctForSensorPosition } from "../streams/transforms.js";
import type { Config } from "../config.js";
import { cellAt, DEFINITIONS } from "./geometry.js";
import { depthLabels } from "./surface.js";

export type PreviewView = readonly [number, number, number, number, number];
export type Observation = {
  lon: number;
  lat: number;
  depth: number;
  time: number;
};
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Preview is evidence of an observation, never an input to the refined statistic. */
export function observation(data: BathymetryData): Observation | undefined {
  const { longitude: lon, latitude: lat, depth } = data;
  const time = data.timestamp.epochMilliseconds;
  if (
    ![lon, lat, depth, time].every(Number.isFinite) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 85.0511 ||
    depth <= 0 ||
    depth > DEFINITIONS.qc.max_depth_m ||
    time < Date.parse(DEFINITIONS.qc.earliest) ||
    time > Date.now() + 86400_000
  )
    return;
  return { lon: lon === 180 ? -180 : lon, lat, depth, time };
}

/** One latest observation per cell: bounded by visited water, not time at anchor. */
export function createPreviewStore(
  db: DatabaseSync,
  config: string,
  onBusy: (busy: boolean) => void = () => {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS preview_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preview_cells(py INTEGER, px INTEGER, lon REAL NOT NULL,
      lat REAL NOT NULL, depth REAL NOT NULL, time INTEGER NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY(py, px)) WITHOUT ROWID;
    DROP INDEX IF EXISTS preview_lat;
    CREATE TABLE IF NOT EXISTS preview_windows(source TEXT, start INTEGER, end INTEGER,
      PRIMARY KEY(source, start, end)) WITHOUT ROWID;`);
  const meta = db.prepare("SELECT value FROM preview_meta WHERE key = ?");
  const put = db.prepare("INSERT OR REPLACE INTO preview_meta VALUES(?, ?)");
  const value = (key: string) =>
    (meta.get(key) as { value: string } | undefined)?.value;
  let spatial: ReturnType<typeof createPreviewSpatial> | undefined;
  let unavailable: string | undefined;
  try {
    spatial = createPreviewSpatial(db);
    // IF NOT EXISTS alone does not open an existing virtual table's module.
    db.prepare("SELECT 1 FROM preview_spatial LIMIT 1").get();
    db.exec("DELETE FROM preview_meta WHERE key='spatial_unavailable'");
  } catch (error) {
    if (String(error).includes("no such module: rtree_i32"))
      disablePreviewSpatial(db, String(error));
    else if (!isolateDamagedPreview(db, error)) throw error;
    unavailable = String(error);
    spatial = undefined;
  }
  db.exec("BEGIN IMMEDIATE");
  let generation: string;
  try {
    if (value("config") !== config) {
      if (spatial) clearPreviewSpatial(db);
      else db.exec("DELETE FROM preview_cells; DELETE FROM preview_windows");
      put.run("config", config);
    }
    generation = String(Number(value("generation") ?? 0) + 1);
    put.run("generation", generation);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  let closed = false;
  const current = () => !closed && value("generation") === generation;
  const write = createPreviewWriter(db, generation);
  let writingThread: ReturnType<typeof createPreviewWriteThread> | undefined;
  const has = db.prepare(
    "SELECT 1 FROM preview_windows WHERE source=? AND start=? AND end=?",
  );
  const query = spatial ? createPreviewQuery(db) : undefined;
  let migration: Promise<void> | undefined;
  let worker: Worker | undefined;
  let priorityView: PreviewView | undefined;
  let priorityKey: string | undefined;
  const prioritize = (view: PreviewView | undefined) => {
    if (!view) return;
    const key = JSON.stringify(view);
    if (key === priorityKey) return;
    priorityView = view;
    priorityKey = key;
    worker?.postMessage({ view });
  };
  return {
    current,
    spatial: spatial !== undefined,
    get unavailable() {
      return unavailable ?? value("spatial_unavailable");
    },
    close() {
      closed = true;
      return Promise.all([worker?.terminate(), writingThread?.close()]);
    },
    prepare(view?: PreviewView) {
      if (!current() || !spatial || unavailable || value("spatial_unavailable"))
        return Promise.resolve();
      prioritize(view);
      if (migration) return migration;
      if (spatial.ready()) return Promise.resolve();
      const file = db.location();
      if (!file)
        return (migration = (async () => {
          while (current() && !spatial!.fill(generation)) await setImmediate();
        })().finally(() => {
          migration = undefined;
        }));
      return (migration = new Promise<void>((resolve, reject) => {
        worker = new Worker(
          new URL("./preview-spatial-worker.js", import.meta.url),
          { workerData: { file, generation, view: priorityView } },
        );
        let finished = false;
        let failure: Error | undefined;
        worker.once(
          "message",
          (message: { error?: string; done?: boolean }) => {
            finished = message.done === true;
            if (message.error) failure = new Error(message.error);
          },
        );
        worker.once("error", (error) => {
          failure = error instanceof Error ? error : new Error(String(error));
        });
        worker.once("exit", (code) => {
          if (closed || (code === 0 && finished && !failure)) resolve();
          else
            reject(
              failure ?? new Error(`Preview index worker exited: ${code}`),
            );
        });
      }).finally(() => {
        migration = undefined;
        worker = undefined;
      }));
    },
    done(source: string, start: number, end: number) {
      return !!has.get(source, start, end);
    },
    write(source: string, points: Observation[], window?: [number, number]) {
      if (!closed) write(source, points, window);
    },
    async writeAsync(
      source: string,
      points: Observation[],
      window?: [number, number],
    ) {
      if (closed) return;
      onBusy(true);
      try {
        const file = db.location();
        if (!file) write(source, points, window);
        else {
          const thread = (writingThread ??= createPreviewWriteThread(
            file,
            generation,
          ));
          try {
            await thread.write(source, points, window);
          } catch (error) {
            if (writingThread === thread) writingThread = undefined;
            await thread.close();
            throw error;
          }
        }
      } finally {
        onBusy(false);
      }
    },
    features(view: PreviewView | undefined, since: number) {
      if (
        !view ||
        !current() ||
        !query ||
        unavailable ||
        value("spatial_unavailable")
      )
        return [];
      prioritize(view);
      let rows;
      try {
        rows = query.read(view, since);
      } catch (error) {
        if (![11, 267].includes((error as { errcode: number })?.errcode))
          throw error;
        unavailable = String(error);
        return [];
      }
      return rows.map((s) => ({
        type: "Feature",
        id: `history:${s.py}:${s.px}`,
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: {
          ...depthLabels(s.depth),
          provisional: true,
          reference: "untided",
          time: s.time,
        },
      }));
    },
  };
}

export type PreviewStore = ReturnType<typeof createPreviewStore>;

/** Bounded waits discard late answers; provider APIs don't necessarily cancel queries. */
async function request<T>(
  run: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("preview stopped"));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => reject(new Error("preview source timed out")),
      30_000,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(run), cancelled]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", abort!);
  }
}

/** Preview acquisition never waits for the chronological QC backfill or tide server. */
export async function scanPreview({
  source,
  store,
  config,
  signal,
  until,
  since = BATHY_EPOCH.epochMilliseconds,
  onError = () => {},
  view = () => undefined,
}: {
  source: BathymetrySource;
  view?: () => PreviewView | undefined;
  store: PreviewStore;
  config: Config;
  signal: AbortSignal;
  until: number;
  since?: number;
  onError?: (error: unknown) => void;
}) {
  const name = source.createWriter ? "local" : "history";
  const correct = correctForSensorPosition(config);
  const frame = (from: number, to: number) =>
    new Timeframe(
      Temporal.Instant.fromEpochMilliseconds(from),
      Temporal.Instant.fromEpochMilliseconds(to),
    );
  const active = () => !signal.aborted && store.current();
  const read = async (from: number, to: number) => {
    if (from >= to || store.done(name, from, to)) return;
    const reader = await request(
      () =>
        (source.createPreviewReader ?? source.createReader)(frame(from, to)),
      signal,
    );
    if (!active()) {
      reader?.destroy();
      return;
    }
    const points = new Map<string, Observation>();
    let publish: Observation[] = [];
    if (reader) {
      const abort = () => reader.destroy();
      const timer = setTimeout(
        () => reader.destroy(new Error("preview read timed out")),
        30_000,
      );
      signal.addEventListener("abort", abort, { once: true });
      try {
        let count = 0;
        for await (const data of reader) {
          if (!active()) return;
          const corrected = correct(data);
          const s = corrected && observation(corrected);
          if (s && s.time >= from && s.time < to) {
            const { py, px } = cellAt(s.lon, s.lat);
            const key = `${py}:${px}`;
            if (!points.has(key) || points.get(key)!.time <= s.time)
              points.set(key, s);
            publish.push(s);
            if (points.size > 50_000)
              throw new Error("preview window exceeds cell limit");
          }
          if (++count % 250 === 0) {
            await store.writeAsync(name, publish);
            publish = [];
            await setImmediate();
          }
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reader.destroy();
      }
    }
    if (!active()) return;
    // Recent provider writes can still arrive; never checkpoint that tail as settled.
    const settled = to <= Date.now() - BATHY_REPORT_DELAY.total("milliseconds");
    await store.writeAsync(
      name,
      [...points.values()],
      settled ? [from, to] : undefined,
    );
  };
  // Retry failures without converting them to empty successful intervals.
  const retry = async (run: () => Promise<void>) => {
    while (active()) {
      try {
        await run();
        return;
      } catch (err) {
        if (!active()) return;
        onError(err);
        // An in-process provider query cannot be cancelled. Don't stack retries
        // behind a timed-out call that may still be executing.
        if (err instanceof Error && err.message === "preview source timed out")
          throw err;
        await sleep(30_000, undefined, { signal }).catch(() => {});
      }
    }
  };
  let viewed: string | undefined;
  let spatial = source.getPreviewTimeframes;
  const prioritize = async () => {
    const area = view();
    if (!spatial || !area || JSON.stringify(area) === viewed || !active())
      return;
    viewed = JSON.stringify(area);
    const [, west, south, east, north] = area;
    let windows: Timeframe[];
    try {
      windows = await request(
        () => spatial!(frame(since, until), [west, south, east, north]),
        signal,
      );
    } catch (err) {
      // A server may expose the API without a spatial provider; use recent-first.
      spatial = undefined;
      if (active()) onError(err);
      return;
    }
    for (const window of windows.slice(0, 64)) {
      if (!active() || JSON.stringify(view()) !== viewed) return;
      await read(
        Math.max(since, window.from.epochMilliseconds),
        Math.min(until, window.to.epochMilliseconds),
      );
    }
  };
  await retry(() => read(Math.max(since, until - HOUR), until));
  await retry(prioritize);
  let to = Math.floor(until / HOUR) * HOUR;
  let span = DAY;
  while (to > since && active()) {
    const from = Math.max(since, to - span);
    await retry(async () => {
      if (store.done(name, from, to)) return;
      const windows = await request(
        () =>
          source.getAvailableTimeframes(
            frame(from, to),
            Temporal.Duration.from({ hours: 1 }),
          ),
        signal,
      );
      if (!active()) return;
      await prioritize();
      for (const w of windows.sort(
        (a, b) => b.from.epochMilliseconds - a.from.epochMilliseconds,
      )) {
        if (!active()) return;
        await prioritize();
        await read(
          Math.max(from, w.from.epochMilliseconds),
          Math.min(to, w.to.epochMilliseconds),
        );
      }
      if (
        active() &&
        to <= Date.now() - BATHY_REPORT_DELAY.total("milliseconds")
      )
        await store.writeAsync(name, [], [from, to]);
      span = windows.length ? DAY : Math.min(span * 2, 365 * DAY);
    });
    to = from;
    await setImmediate();
  }
}
