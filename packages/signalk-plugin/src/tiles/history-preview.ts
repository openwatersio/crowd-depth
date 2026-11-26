import {
  ObservationDataError,
  isObservationDataError,
} from "../observations/errors.js";
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
      db.exec("DROP TRIGGER IF EXISTS preview_local_deleted");
      if (spatial) clearPreviewSpatial(db);
      else db.exec("DELETE FROM preview_cells; DELETE FROM preview_windows");
      put.run("config", config);
    }
    // This trigger also runs under older writers after rollback. Recover on the
    // next startup without scanning/deleting coverage once per removed cell.
    if (value("local_rebuild_required")) {
      db.exec(
        "DELETE FROM preview_windows WHERE source='local:v2'; DELETE FROM preview_meta WHERE key='local_rebuild_required';",
      );
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS preview_local_deleted AFTER DELETE ON preview_cells
      WHEN OLD.source='local' BEGIN
        INSERT OR IGNORE INTO preview_meta(key,value) VALUES('local_rebuild_required','1');
      END;`);
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
      return !!has.get(
        source === "history"
          ? "history:v2"
          : source === "local"
            ? "local:v2"
            : source,
        start,
        end,
      );
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
        30_000 *
          Math.max(
            1,
            Math.ceil(
              (to - from) / (source.observationRequestMilliseconds ?? Infinity),
            ),
          ),
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
              throw new ObservationDataError(
                "preview window exceeds cell limit",
              );
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
  // Keep distinct holes so unrelated healthy spans can be checkpointed. In a
  // severely damaged archive, coalesce the closest holes to bound bookkeeping;
  // this can repeat a healthy gap, but never marks failed data complete.
  let failures: [number, number][] = [];
  const compactFailures = () => {
    failures.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of failures) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    while (merged.length > 512) {
      let closest = 1;
      for (let i = 2; i < merged.length; i++)
        if (
          merged[i][0] - merged[i - 1][1] <
          merged[closest][0] - merged[closest - 1][1]
        )
          closest = i;
      merged[closest - 1][1] = merged[closest][1];
      merged.splice(closest, 1);
    }
    failures = merged;
  };
  const readSafely = async (from: number, to: number) => {
    try {
      await read(from, to);
      failures = failures.flatMap(([a, b]): [number, number][] => {
        if (to <= a || from >= b) return [[a, b]];
        return [
          ...(a < from ? [[a, from] as [number, number]] : []),
          ...(b > to ? [[to, b] as [number, number]] : []),
        ];
      });
      if (failures.length > 512) compactFailures();
      return true;
    } catch (error) {
      if (!active()) return false;
      // Also retain a hole when a transient viewport retry yields to a pan.
      failures.push([from, to]);
      compactFailures();
      if (!isObservationDataError(error)) throw error;
      onError(error);
      return false;
    }
  };
  // Retry failures without converting them to empty successful intervals.
  const retry = async (run: () => Promise<void>, relevant?: () => boolean) => {
    while (active() && (!relevant || relevant())) {
      try {
        await run();
        return;
      } catch (err) {
        if (!active()) return;
        onError(err);
        // An in-process provider query cannot be cancelled. Don't stack retries
        // behind a timed-out call that may still be executing. An independent
        // startup task may finish before that timeout is propagated.
        if (err instanceof Error && err.message === "preview source timed out")
          throw err;
        // A viewport failure must yield promptly when the user pans elsewhere.
        for (
          let remaining = 30_000;
          remaining > 0 && active() && (!relevant || relevant());
        ) {
          const delay = relevant ? Math.min(250, remaining) : remaining;
          await sleep(delay, undefined, { signal }).catch(() => {});
          remaining -= delay;
        }
      }
    }
  };
  let viewed: string | undefined;
  let storedView: string | undefined;
  let spatial = source.getPreviewTimeframes;
  const prioritize = async (localOnly = false) => {
    const area = view();
    if (!area || JSON.stringify(area) === viewed || !active()) return;
    viewed = JSON.stringify(area);
    let completed = false;
    try {
      const [, west, south, east, north] = area;
      const draw = async (windows: Timeframe[]) => {
        for (const window of windows.slice(0, 64)) {
          if (!active() || JSON.stringify(view()) !== viewed) return;
          const requestedView = viewed;
          await retry(
            async () => {
              await readSafely(
                Math.max(since, window.from.epochMilliseconds),
                Math.min(until, window.to.epochMilliseconds),
              );
            },
            () => JSON.stringify(view()) === requestedView,
          );
        }
      };
      if (
        storedView !== viewed &&
        (source.getStoredTimeframePage || source.getStoredTimeframes)
      ) {
        if (source.getStoredTimeframePage) {
          let before: number | undefined;
          let count = 0;
          // Sparse spatial pages need not be full. Paint each before requesting the next.
          for (let pages = 0; pages < 64 && count < 64; pages++) {
            if (!active() || JSON.stringify(view()) !== viewed) return;
            const page = await request(
              () =>
                source.getStoredTimeframePage!(
                  frame(since, until),
                  [west, south, east, north],
                  before,
                ),
              signal,
            );
            const windows = page.windows.slice(0, 64 - count);
            await draw(windows);
            count += windows.length;
            if (page.before === undefined) break;
            if (before !== undefined && page.before >= before)
              throw new Error("Stored viewport cursor did not advance");
            before = page.before;
          }
        } else
          await draw(
            await request(
              () =>
                source.getStoredTimeframes!(frame(since, until), [
                  west,
                  south,
                  east,
                  north,
                ]),
              signal,
            ),
          );
        if (active() && JSON.stringify(view()) === viewed) storedView = viewed;
      }
      if (localOnly) {
        // Leave remote discovery pending, while owned coverage survives a stalled recent read.
        return;
      }
      // Existing local coverage is painted before waiting on external track discovery.
      if (!active() || JSON.stringify(view()) !== viewed) return;
      if (!spatial) {
        completed = true;
        return;
      }
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
        completed = active() && JSON.stringify(view()) === viewed;
        return;
      }
      await draw(windows);
      completed = active() && JSON.stringify(view()) === viewed;
    } finally {
      if (!completed) viewed = undefined;
    }
  };
  // Either source can provide first content; neither gets to block the other's read.
  const startup = await Promise.allSettled([
    view() && (source.getStoredTimeframePage || source.getStoredTimeframes)
      ? retry(() => prioritize(true))
      : Promise.resolve(),
    retry(async () => {
      await readSafely(Math.max(since, until - HOUR), until);
    }),
  ]);
  // Observe both tasks before returning; neither may keep publishing after a failed scan.
  for (const result of startup)
    if (result.status === "rejected") throw result.reason;
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
        await readSafely(
          Math.max(from, w.from.epochMilliseconds),
          Math.min(to, w.to.epochMilliseconds),
        );
      }
      // Provider retention does not establish completeness of the owned archive.
      if (source.getStoredTimeframePage) {
        let before: number | undefined;
        do {
          const previous = before;
          const page = await request(
            () =>
              source.getStoredTimeframePage!(
                frame(from, to),
                [-180, -90, 180, 90],
                before,
              ),
            signal,
          );
          before = page.before;
          if (
            before !== undefined &&
            (!Number.isSafeInteger(before) ||
              before < 1 ||
              (previous !== undefined && before >= previous))
          )
            throw new Error("Owned preview cursor did not advance");
          for (const window of page.windows) {
            if (!active()) return;
            await prioritize();
            await readSafely(
              Math.max(from, window.from.epochMilliseconds),
              Math.min(to, window.to.epochMilliseconds),
            );
          }
          await setImmediate();
        } while (before !== undefined && active());
      }
      if (
        active() &&
        to <= Date.now() - BATHY_REPORT_DELAY.total("milliseconds")
      ) {
        let cursor = from;
        for (const [a, b] of failures) {
          if (b <= cursor || a >= to) continue;
          if (a > cursor) await store.writeAsync(name, [], [cursor, a]);
          cursor = Math.max(cursor, b);
        }
        if (cursor < to) await store.writeAsync(name, [], [cursor, to]);
      }
      // The temporal scan has passed these holes; their missing checkpoints
      // persist in the store and will be retried on a future scan.
      failures = failures
        .filter(([a]) => a < from)
        .map(([a, b]) => [a, Math.min(b, from)]);
      span = windows.length ? DAY : Math.min(span * 2, 365 * DAY);
    });
    to = from;
    await setImmediate();
  }
}
