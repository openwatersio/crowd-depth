import { pipeline } from "stream/promises";
import { setImmediate } from "node:timers/promises";
import { Temporal } from "@js-temporal/polyfill";
import { transform } from "stream-transform";
import { ServerAPI } from "@signalk/server-api";
import { Config } from "../config.js";
import { BathymetryData, BathymetrySource, Timeframe } from "../types.js";
import { correctForSensorPosition } from "../streams/index.js";
import { CellStore } from "./cells.js";
import { Writable } from "stream";
import { Worker } from "node:worker_threads";
import { createCellWriter, getThrough, setThrough } from "./writer.js";

/** How far back a store with no cells yet is filled from the plugin's source. */
export const BACKFILL_PERIOD = Temporal.Duration.from({ hours: 30 * 24 });

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
 * it last recorded, or {@link BACKFILL_PERIOD} for a new store, up to `until`,
 * never more than {@link BACKFILL_PERIOD} back. A span left from a backfill
 * that didn't finish is widened, not replaced, so an interrupted backfill is
 * run again in full.
 */
export function addPendingBackfill(store: CellStore, until: Temporal.Instant) {
  // Never more than BACKFILL_PERIOD back, however long the layer was off.
  const earliest = until.subtract(BACKFILL_PERIOD);
  const through = getThrough(store);
  let from =
    through && Temporal.Instant.compare(through, earliest) > 0
      ? through
      : earliest;
  let to = until;
  const pending = getPendingBackfill(store);
  if (pending) {
    if (Temporal.Instant.compare(pending.from, from) < 0) {
      from =
        Temporal.Instant.compare(pending.from, earliest) > 0
          ? pending.from
          : earliest;
    }
    if (Temporal.Instant.compare(pending.to, to) > 0) to = pending.to;
  }
  if (Temporal.Instant.compare(from, to) >= 0) return;
  store.setMeta(PENDING_KEY, `${from}/${to}`);
}

/** Give up on the pending span, once it is done or when the cells are cleared. */
export function clearPendingBackfill(store: CellStore) {
  store.setMeta(PENDING_KEY, "");
  store.setMeta(FAILURES_KEY, "");
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
}: {
  app: ServerAPI;
  config: Config;
  source: BathymetrySource;
  store: CellStore;
  signal: AbortSignal;
  /** The database file, for the cells to be written on a worker thread; without it,
   * as for an in-memory database, they're written on this one. */
  file?: string;
}): Promise<void> {
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

  // Sources round windows out to whole hours; soundings past the span were
  // already written live.
  const windows = (await source.getAvailableTimeframes(pending, WINDOW)).map(
    (window) => window.clamp(pending),
  );
  if (windows.length > 0) {
    app.debug(`Backfilling chart cells from ${windows.length} windows`);
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
      file
        ? createWorkerSink(file)
        : createCellWriter(store, { bulk: true, overviews: false }),
      { signal },
    );
    if (!file) store.rebuildOverviews();
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
  const settle = (err?: Error | null) => {
    const w = waiting;
    waiting = undefined;
    w?.(err);
  };
  worker.on("message", (msg: { ack?: true; done?: true; error?: string }) => {
    if (msg.error) settle(new Error(msg.error));
    else settle();
  });
  worker.on("error", (err) => settle(err as Error));
  const send = (msg: object, done: (err?: Error | null) => void) => {
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
