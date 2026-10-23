import { pipeline } from "stream/promises";
import { setImmediate } from "node:timers/promises";
import { Temporal } from "@js-temporal/polyfill";
import { transform } from "stream-transform";
import { ServerAPI } from "@signalk/server-api";
import { Config, historySpan } from "../config.js";
import { BATHY_EPOCH } from "../constants.js";
import { BathymetryData, BathymetrySource, Timeframe } from "../types.js";
import { correctForSensorPosition } from "../streams/index.js";
import { CellStore } from "./cells.js";
import { Writable } from "stream";
import { Worker } from "node:worker_threads";
import {
  THROUGH_KEY,
  createCellWriter,
  getThrough,
  setThrough,
} from "./writer.js";
import { DEFINITIONS } from "./geometry.js";
import { Tides, withTide } from "./tide.js";

/** Meta key set while a backfill's cells are without their overviews. */
const OVERVIEWS_STALE_KEY = "overviews_stale";

/** Meta key for the span still waiting to be backfilled, as `from/to`. */
const PENDING_KEY = "backfill";

/** Meta key for when the depth reference last changed. The plugin's SQLite log
 * stores depths with the offset of their day, so it can't rebuild depths from
 * before this; the History API applies the current offset as it reads. */
export const DEPTH_SINCE_KEY = "depth_since";

/** Soundings read between turns of the event loop. The SQLite source reads
 * synchronously, so without a pause a long backfill would hold up the whole
 * Signal K server. */
const YIELD_EVERY = 1000;

/** How long a backfill waits for signalk-tides, which may start after this plugin,
 * before it goes on without tide. */
export const TIDES_WAIT_MS = 60_000;

/** Meta key for the tide the cells were built with: the tide's definitions where
 * signalk-tides answered as the layer started, and null where it didn't. */
export const TIDE_CONFIG_KEY = "config_tide";

/** The {@link TIDE_CONFIG_KEY} value for cells built with or without tide. */
export const tideConfig = (tided: boolean) =>
  JSON.stringify(tided ? DEFINITIONS.tide : null);

/** Whether the cells were built another way than `tided`, so a backfill rebuilds them. A
 * store with no record is a new layer's, built this way from the start. */
export function tideChanged(store: CellStore, tided: boolean) {
  const builtWith = store.getMeta(TIDE_CONFIG_KEY);
  return builtWith !== undefined && builtWith !== tideConfig(tided);
}

/** How much of the span the source is asked about at once, for the windows with data. */
const AVAILABILITY_SPAN = Temporal.Duration.from({ hours: 365 * 24 });

/** Size of each read from the source. */
const WINDOW = Temporal.Duration.from({ hours: 1 });

export function getPendingBackfill(store: CellStore): Timeframe | undefined {
  const value = store.getMeta(PENDING_KEY);
  if (!value) return undefined;
  const [from, to] = value.split("/").map((v) => Temporal.Instant.from(v));
  return new Timeframe(from, to);
}

/**
 * Record the span the live writer didn't see, before it starts writing: since
 * it last recorded, or `span` back for a new store, up to `until`, never more
 * than `span` back; all of the source's history without one. A span left from a
 * backfill that didn't finish goes on from as far as it got, up to `until`.
 */
export function addPendingBackfill(
  store: CellStore,
  until: Temporal.Instant,
  span: Temporal.Duration | undefined,
) {
  const pending = getPendingBackfill(store);
  // Never more than the span back, however long the layer was off.
  const earliest = span ? until.subtract(span) : BATHY_EPOCH;
  let from = pending?.from ?? getThrough(store) ?? earliest;
  if (Temporal.Instant.compare(from, earliest) < 0) from = earliest;
  const to =
    pending && Temporal.Instant.compare(pending.to, until) > 0
      ? pending.to
      : until;
  if (Temporal.Instant.compare(from, to) >= 0) return;
  store.setMeta(PENDING_KEY, `${from}/${to}`);
}

/** Give up on the pending span, once it is done or when the cells are cleared. */
export function clearPendingBackfill(store: CellStore) {
  store.setMeta(PENDING_KEY, "");
  store.setMeta(FAILURES_KEY, "");
}

/** Move the pending span's start up to `micros`, the oldest sounding a backfill has
 * yet to write, so one that is stopped goes on from there rather than folding in
 * again what it wrote. A backfill getting somewhere starts its failures afresh: only
 * starts in a row that get nowhere give the span up. */
export function advancePendingBackfill(store: CellStore, micros: number) {
  const pending = getPendingBackfill(store);
  if (!pending) return;
  const from = Temporal.Instant.fromEpochMilliseconds(
    Math.floor(micros / 1000),
  );
  if (
    Temporal.Instant.compare(from, pending.from) > 0 &&
    Temporal.Instant.compare(from, pending.to) < 0
  ) {
    store.setMeta(PENDING_KEY, `${from}/${pending.to}`);
    store.setMeta(FAILURES_KEY, "");
  }
}

/** Clear the cells for the backfill to build afresh. */
export function startRebuild(store: CellStore) {
  store.clear();
  store.setMeta(THROUGH_KEY, "");
  clearPendingBackfill(store);
}

/** Meta key for how many starts in a row the pending span has failed. */
const FAILURES_KEY = "backfill_failures";

/** Starts a pending span may fail before it is given up on. A source that is
 * slow to come up (an InfluxDB still starting at boot) gets a few chances; one
 * that fails on the same data every time doesn't cost every start forever. */
export const MAX_BACKFILL_FAILURES = 3;

/** Record a failed backfill, giving up on the span after
 * {@link MAX_BACKFILL_FAILURES} in a row. Returns whether it will be retried. */
export function recordBackfillFailure(store: CellStore): boolean {
  const failures = Number(store.getMeta(FAILURES_KEY) || 0) + 1;
  if (failures >= MAX_BACKFILL_FAILURES) {
    // Past the span, or the next start would add the same gap again.
    const pending = getPendingBackfill(store);
    if (pending) setThrough(store, pending.to.epochMilliseconds * 1000);
    clearPendingBackfill(store);
    return false;
  }
  store.setMeta(FAILURES_KEY, String(failures));
  return true;
}

/**
 * Fill the cells for the pending span from the plugin's own source (the
 * History API or its SQLite log). Soundings go through the same position
 * correction as what the plugin submits, so the chart shows what is shared.
 * The span is cleared, and the marker moved to its end, only once its cells are
 * written.
 */
export async function backfillCells({
  app,
  config,
  source,
  store,
  signal,
  file,
  tides,
  until = Temporal.Now.instant(),
}: {
  app: ServerAPI;
  config: Config;
  source: BathymetrySource;
  store: CellStore;
  signal: AbortSignal;
  /** Tide levels to reduce the soundings with; without them they stay untided. */
  tides?: Tides;
  /** When the live writer started, which a rebuild for a tide change backfills up to:
   * it holds its passes from then on for the rebuild. */
  until?: Temporal.Instant;
  /** The database file, for the cells to be written on a worker thread; without it,
   * as for an in-memory database, they're written on this one. */
  file?: string;
}): Promise<void> {
  // The cells are reduced if signalk-tides answered as the layer started, not merely if
  // it's installed: a change either way, such as read-only access turned on for it,
  // rebuilds them. The answer is the start's, so a start that finds it as the last did
  // rebuilds nothing.
  const tided =
    tides !== undefined &&
    (await tides.ready(TIDES_WAIT_MS, { signal }).catch(() => false));
  if (signal.aborted) return;
  if (tideChanged(store, tided)) {
    app.debug("Tide changed: rebuilding the chart layer");
    startRebuild(store);
    addPendingBackfill(store, until, historySpan(config));
  }
  store.setMeta(TIDE_CONFIG_KEY, tideConfig(tided));
  const rebuild = async () => {
    if (file) await rebuildOverviewsOnWorker(file, signal);
    else store.rebuildOverviews();
    store.setMeta(OVERVIEWS_STALE_KEY, "");
  };
  // A backfill stopped with the plugin left cells without their overviews. A rebuild
  // that fails isn't the backfill's failure: the span below is still read, and the
  // mark stays for the next try.
  if (store.getMeta(OVERVIEWS_STALE_KEY)) {
    await rebuild().catch((err: unknown) => {
      if (!signal.aborted) app.error(`Chart overview rebuild failed: ${err}`);
    });
    if (signal.aborted) return;
  }

  let pending = getPendingBackfill(store);
  if (!pending) return;
  // The SQLite log is the source that can write; its depths from before a
  // depth reference change were recorded with the old offset.
  const depthSince = store.getMeta(DEPTH_SINCE_KEY);
  if (source.createWriter && depthSince) {
    const since = Temporal.Instant.from(depthSince);
    if (Temporal.Instant.compare(since, pending.to) >= 0) {
      clearPendingBackfill(store);
      return;
    }
    if (Temporal.Instant.compare(since, pending.from) > 0) {
      pending = new Timeframe(since, pending.to);
    }
  }

  // Asked a year at a time, so all of a boat's history isn't one request to the
  // provider. Sources round windows out to whole hours, so each is clamped to its
  // year: one crossing into the next is read once. Soundings past the span were
  // already written live.
  const windows: Timeframe[] = [];
  for (
    let from = pending.from;
    Temporal.Instant.compare(from, pending.to) < 0;
  ) {
    const next = from.add(AVAILABILITY_SPAN);
    const year = new Timeframe(
      from,
      Temporal.Instant.compare(next, pending.to) < 0 ? next : pending.to,
    );
    for (const window of await source.getAvailableTimeframes(year, WINDOW)) {
      windows.push(window.clamp(year));
    }
    from = year.to;
  }
  if (windows.length > 0) {
    app.debug(`Backfilling chart cells from ${windows.length} windows`);
    // Its cells get their overviews at the end; until then they're marked missing,
    // so a backfill that doesn't get there is made good by the next.
    store.setMeta(OVERVIEWS_STALE_KEY, "1");
    try {
      await pipeline(
        async function* () {
          let read = 0;
          for (const window of windows) {
            if (signal.aborted) return;
            const reader = await source.createReader(window);
            if (!reader) continue;
            for await (const sounding of reader) {
              yield sounding;
              if (++read % YIELD_EVERY === 0) await setImmediate();
            }
          }
        },
        transform(correctForSensorPosition(config)),
        // On this thread, so the worker never waits on the server it would ask.
        ...(tided && tides ? [withTide(tides)] : []),
        file
          ? createWorkerSink(file)
          : createCellWriter(store, {
              bulk: true,
              overviews: false,
              progress: (micros) => advancePendingBackfill(store, micros),
            }),
        { signal },
      );
      // The worker rebuilt them as it finished.
      if (file) store.setMeta(OVERVIEWS_STALE_KEY, "");
      else await rebuild();
    } catch (err) {
      // The cells it wrote have no overviews yet, so zoomed out they'd not show.
      // Plugin stopping: the next start's backfill rebuilds them.
      if (!signal.aborted) await rebuild().catch(() => {});
      throw err;
    }
  }
  if (signal.aborted) return;
  // Done through the span's end, where the live writer took over, so a later start
  // doesn't fold the same passes in again even if the live writer has written nothing.
  setThrough(store, pending.to.epochMilliseconds * 1000);
  clearPendingBackfill(store);
}

/** Soundings sent to the backfill worker at a time. Each batch waits for the worker to
 * take the last, so a fast source can't pile soundings up in memory. */
const WORKER_BATCH = 2000;

/** A Writable that hands soundings to the backfill worker and finishes once the worker
 * has written them all and rebuilt the overviews. */
export function createWorkerSink(file: string): Writable {
  const worker = new Worker(new URL("./backfill-worker.js", import.meta.url), {
    workerData: { file },
  });
  let batch: object[] = [];
  let waiting: ((err?: Error | null) => void) | undefined;
  // The worker's first failure, kept: it may arrive between batches, with nothing
  // waiting, and every later send must fail with it rather than wait for an answer
  // that won't come.
  let failed: Error | undefined;
  let finished = false;
  const settle = (err?: Error | null) => {
    if (err) failed ??= err;
    const w = waiting;
    waiting = undefined;
    w?.(err ?? undefined);
  };
  worker.on("message", (msg: { ack?: true; done?: true; error?: string }) => {
    if (msg.done) finished = true;
    settle(msg.error ? new Error(msg.error) : undefined);
  });
  worker.on("error", (err) => settle(err as Error));
  worker.on("exit", (code) => {
    if (!finished) settle(new Error(`backfill worker exited (${code})`));
  });
  const send = (msg: object, done: (err?: Error | null) => void) => {
    if (failed) return done(failed);
    waiting = done;
    worker.postMessage(msg);
  };
  return new Writable({
    objectMode: true,
    write(data: BathymetryData, _encoding, callback) {
      batch.push({
        longitude: data.longitude,
        latitude: data.latitude,
        depth: data.depth,
        heading: data.heading,
        time: data.timestamp.epochMilliseconds,
        tide: data.tide,
      });
      if (batch.length < WORKER_BATCH) return callback();
      const sending = batch;
      batch = [];
      send({ batch: sending }, callback);
    },
    final(callback) {
      const finish = () =>
        send({ end: true }, (err) => {
          void worker.terminate();
          callback(err);
        });
      if (batch.length === 0) return finish();
      const sending = batch;
      batch = [];
      send({ batch: sending }, (err) => (err ? callback(err) : finish()));
    },
    destroy(error, callback) {
      void worker.terminate();
      callback(error);
    },
  });
}

/** Rebuild the overviews on a worker thread, as after a backfill that failed. */
function rebuildOverviewsOnWorker(
  file: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  const worker = new Worker(new URL("./backfill-worker.js", import.meta.url), {
    workerData: { file },
  });
  let abort = () => {};
  return new Promise<void>((resolve, reject) => {
    worker.on("message", (msg: { done?: true; error?: string }) => {
      if (msg.error) reject(new Error(msg.error));
      else if (msg.done) resolve();
    });
    worker.on("error", reject);
    worker.on("exit", () => reject(new Error("backfill worker exited")));
    // Stopped, as before a restart that clears the cells: the rebuild mustn't write
    // overviews of cells that are gone.
    abort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", abort);
    worker.postMessage({ rebuild: true });
  }).finally(async () => {
    signal.removeEventListener("abort", abort);
    await worker.terminate();
  });
}
