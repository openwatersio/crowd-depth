import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { transform } from "stream-transform";
import { Worker } from "node:worker_threads";
import { Temporal } from "@js-temporal/polyfill";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import type { Config } from "../config.js";
import { Timeframe, type BathymetrySource } from "../types.js";
import { correctForSensorPosition } from "../streams/transforms.js";
import { type CellStore, type Pass, type Shoal } from "./cells.js";
import { createCellWriter, setThrough, type Changed } from "./writer.js";
import { cellCenter } from "./geometry.js";
import { withTide, type Tides } from "./tide.js";
import {
  getPendingBackfill,
  clearPendingBackfill,
  DEPTH_SINCE_KEY,
} from "./backfill.js";
import type { PreviewView } from "./history-preview.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const frame = (from: number, to: number) =>
  new Timeframe(
    Temporal.Instant.fromEpochMilliseconds(from),
    Temporal.Instant.fromEpochMilliseconds(to),
  );

/** Bound uncancellable provider calls without stacking retries behind them. */
async function request<T>(
  run: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  let timer!: ReturnType<typeof setTimeout>;
  const pending = Promise.resolve().then(run);
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("refinement stopped"));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => reject(new Error("refinement source timed out")),
      30_000,
    );
  });
  try {
    return await Promise.race([pending, cancelled]);
  } catch (err) {
    void pending.then(
      (value) => {
        if (value instanceof Readable) value.destroy();
      },
      () => {},
    );
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** Bounded independent job: no incomplete contribution reaches the published cells. */
export function refinementWriter(store: CellStore, from: number, to: number) {
  const passes: Pass[] = [],
    shoals: Shoal[] = [];
  const writer = createCellWriter(
    {
      transaction: (fn) => fn(),
      getMeta: () => undefined,
      setMeta: () => {},
      addPasses: (batch) => {
        passes.push(...batch);
        return [];
      },
      addShoals: (batch) => {
        shoals.push(...batch);
      },
    },
    { bulk: true, range: [from * 1000, to * 1000] },
  );
  return {
    writer,
    commit: () =>
      store
        .replaceWindow(from, to, passes, shoals)
        .map((p) => cellCenter(p.py, p.px)),
  };
}

export class UncertainRefinementCommit extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
  }
}

/** One reusable worker, bounded by acknowledged batches, for independently replaceable jobs. */
function refinementWorker(file: string, generation: string | undefined) {
  const worker = new Worker(new URL("./refine-worker.js", import.meta.url), {
    workerData: { file, generation },
  });
  let waiting:
    | {
        resolve: (result: { changed?: Changed; done?: boolean }) => void;
        reject: (error: Error) => void;
        mayCommit: boolean;
      }
    | undefined;
  let failed: Error | undefined;
  const fail = (error: Error, uncertain = true) => {
    if (failed) return;
    failed =
      uncertain && waiting?.mayCommit
        ? new UncertainRefinementCommit(error)
        : error;
    waiting?.reject(failed);
    waiting = undefined;
  };
  worker.on("error", fail);
  worker.on("exit", (code) =>
    fail(new Error(`refinement worker exited (${code})`)),
  );
  worker.on(
    "message",
    (msg: { error?: string; changed?: Changed; done?: boolean }) => {
      if (msg.error) return fail(new Error(msg.error), false);
      waiting?.resolve(msg);
      waiting = undefined;
    },
  );
  return {
    send(message: object): Promise<{ changed?: Changed; done?: boolean }> {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        const request = message as {
          end?: boolean;
          commit?: boolean;
          reweight?: boolean;
        };
        waiting = {
          resolve,
          reject,
          mayCommit:
            !!request.reweight || (!!request.end && request.commit !== false),
        };
        worker.postMessage(message);
      });
    },
    close: () => worker.terminate(),
  };
}

/** Rebuild weights from retained hour summaries, independent of History availability. */
export async function reweightCells({
  store,
  file,
  signal,
  onChange = () => {},
}: {
  store: CellStore;
  file?: string;
  signal: AbortSignal;
  onChange?: (changed: Changed) => void;
}) {
  if (!store.getMeta("reweight_pending") || signal.aborted) return;
  const worker = file ? refinementWorker(file, store.generation) : undefined;
  const abort = () => {
    void worker?.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = worker
        ? await worker.send({ reweight: true })
        : (() => {
            const next = store.reweightNext();
            return {
              done: next.done,
              changed: next.changed.map((p) => cellCenter(p.py, p.px)),
            };
          })();
      if (result.changed?.length) onChange(result.changed);
      if (result.done) return;
      await setImmediate();
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await worker?.close();
  }
}

/** Refine newest acquired tracks first. Receipts preserve holes independently of order. */
export async function refineHistory({
  source,
  store,
  config,
  signal,
  file,
  tides,
  availableThrough,
  windows,
  view = () => undefined,
  onChange = () => {},
  onError = () => {},
}: {
  source: BathymetrySource;
  store: CellStore;
  config: Config;
  signal: AbortSignal;
  file?: string;
  tides?: Tides;
  availableThrough?: Temporal.Instant;
  /** Explicit viewport work never discovers or advances global history coverage. */
  windows?: Timeframe[];
  view?: () => PreviewView | undefined;
  onChange?: (changed: Changed) => void;
  onError?: (error: unknown) => void;
}) {
  const pending = windows?.length
    ? frame(
        Math.min(...windows.map((w) => w.from.epochMilliseconds)) - HOUR,
        Math.max(...windows.map((w) => w.to.epochMilliseconds)) + HOUR,
      )
    : getPendingBackfill(store);
  if (!pending) return;
  let since = Math.floor(pending.from.epochMilliseconds / HOUR) * HOUR;
  const end = Math.min(
    pending.to.epochMilliseconds,
    availableThrough?.epochMilliseconds ?? Infinity,
  );
  if (source.createWriter && store.getMeta(DEPTH_SINCE_KEY))
    since = Math.max(
      since,
      Temporal.Instant.from(store.getMeta(DEPTH_SINCE_KEY)!).epochMilliseconds,
    );
  if (since >= end) return;
  let worker = file ? refinementWorker(file, store.generation) : undefined;
  const abort = () => {
    void worker?.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  const run = async (start: number, stop: number) => {
    signal.throwIfAborted();
    if (store.windowDone(start, stop, !windows)) return;
    // Read one adjacent hour on each side for QC context. Ownership stays in
    // the central interval, so a boundary never adds the same observation twice.
    const lo = Math.max(since, Math.floor(start / HOUR) * HOUR - HOUR);
    const hi = Math.min(end, Math.ceil(stop / HOUR) * HOUR + HOUR);
    const local = !worker ? refinementWriter(store, start, stop) : undefined;
    if (worker) await worker.send({ start, stop });
    let count = 0;
    let central = 0;
    const input = Readable.from(
      (async function* () {
        for (let at = lo; at < hi;) {
          signal.throwIfAborted();
          const until = Math.min(hi, (Math.floor(at / HOUR) + 1) * HOUR);
          const reader = await request(
            () => source.createReader(frame(at, until)),
            signal,
          );
          // Some local sources use undefined for an empty interval. History's reader
          // returns an empty stream. Errors must propagate; they aren't empty coverage.
          if (reader) {
            const cancel = () =>
              reader.destroy(new Error("refinement stopped"));
            signal.addEventListener("abort", cancel, { once: true });
            const timer = setTimeout(
              () => reader.destroy(new Error("refinement read timed out")),
              30_000,
            );
            try {
              for await (const data of reader) {
                signal.throwIfAborted();
                const time = data.timestamp.epochMilliseconds;
                if (time < at || time >= until) continue;
                if (++count > 300_000)
                  throw new Error("refinement context exceeds 300,000 samples");
                if (time >= start && time < stop) central++;
                yield data;
                if (count % 1000 === 0) await setImmediate();
              }
            } finally {
              clearTimeout(timer);
              signal.removeEventListener("abort", cancel);
              reader.destroy();
            }
          }
          at = until;
        }
      })(),
    );
    const { Writable } = await import("node:stream");
    let batch: object[] = [];
    const sink =
      local?.writer ??
      new Writable({
        objectMode: true,
        write(data, _encoding, callback) {
          batch.push({ ...data, timestamp: data.timestamp.epochMilliseconds });
          if (batch.length < 1000) return callback();
          const sending = batch;
          batch = [];
          worker!.send({ batch: sending }).then(() => callback(), callback);
        },
        final(callback) {
          (async () => {
            if (batch.length) await worker!.send({ batch });
            const { changed = [] } = await worker!.send({
              end: true,
              commit: central > 0,
            });
            onChange(changed);
          })().then(() => callback(), callback);
        },
      });
    await pipeline(
      input,
      transform(correctForSensorPosition(config)),
      ...(tides ? [withTide(tides)] : []),
      sink,
      { signal },
    );
    if (local && central > 0) onChange(local.commit());
    if (central === 0) store.completeEmptyWindow(start, stop);
    return true;
  };
  let incomplete = false;
  let consecutiveFailures = 0;
  const process = async (window: Timeframe) => {
    const from = Math.max(since, window.from.epochMilliseconds);
    const to = Math.min(end, window.to.epochMilliseconds);
    // Always use deterministic hour boundaries, including for spatial hints.
    for (let stop = to; stop > from;) {
      const start = Math.max(from, Math.floor((stop - 1) / HOUR) * HOUR);
      try {
        await run(start, stop);
        consecutiveFailures = 0;
      } catch (err) {
        if (
          signal.aborted ||
          String(err).includes("source timed out") ||
          ++consecutiveFailures >= 5
        )
          throw err;
        incomplete = true;
        onError(err);
        await worker?.close();
        worker = file ? refinementWorker(file, store.generation) : undefined;
      }
      stop = start;
    }
  };
  let viewed = "";
  let prioritizedAt = -Infinity;
  const prioritize = async () => {
    const area = view();
    if (
      !area ||
      !source.getStoredTimeframes ||
      (JSON.stringify(area) === viewed && Date.now() - prioritizedAt < 5000)
    )
      return;
    viewed = JSON.stringify(area);
    prioritizedAt = Date.now();
    const [, west, south, east, north] = area;
    const hints = await source.getStoredTimeframes(frame(since, end), [
      west,
      south,
      east,
      north,
    ]);
    for (const window of hints.slice(0, 64)) {
      if (JSON.stringify(view()) !== viewed) return;
      await process(window);
    }
  };
  try {
    if (windows) {
      for (const window of windows) await process(window);
      if (incomplete) throw new Error("Visible refinement remains pending");
      return;
    }
    // No availability/track query stands between startup and the newest hour.
    await process(
      frame(Math.max(since, Math.floor((end - 1) / HOUR) * HOUR), end),
    );
    let span = DAY;
    const savedDays = Number(store.getMeta("refine_availability_days") ?? 365);
    const maxSpan =
      Math.max(1, Math.min(365, Number.isFinite(savedDays) ? savedDays : 365)) *
      DAY;
    for (let to = Math.floor((end - 1) / HOUR) * HOUR; to > since;) {
      signal.throwIfAborted();
      await prioritize();
      const from = Math.max(since, to - span);
      let windows: Timeframe[];
      try {
        windows = await request(
          () =>
            source.getAvailableTimeframes(
              frame(from, to),
              Temporal.Duration.from({ hours: 1 }),
            ),
          signal,
        );
      } catch (err) {
        if (!signal.aborted && span > DAY)
          store.setMeta(
            "refine_availability_days",
            String(Math.max(1, Math.floor(span / DAY / 2))),
          );
        throw err;
      }
      for (const window of windows.sort(
        (a, b) => b.from.epochMilliseconds - a.from.epochMilliseconds,
      )) {
        await prioritize();
        await process(window.clamp(frame(from, to)));
      }
      to = from;
      span = windows.length ? DAY : Math.min(span * 2, maxSpan);
      await setImmediate();
    }
    signal.throwIfAborted();
    if (incomplete)
      throw new Error(
        "Some refinement windows remain pending; completed windows are retained",
      );
    store.transaction(() => {
      setThrough(store, end * 1000);
      if (end < pending.to.epochMilliseconds)
        store.setMeta(
          "backfill",
          `${Temporal.Instant.fromEpochMilliseconds(end)}/${pending.to}`,
        );
      else clearPendingBackfill(store);
    });
  } finally {
    signal.removeEventListener("abort", abort);
    await worker?.close();
  }
}

/** Visible evidence gets its own bounded worker, even when discovery is stalled.
 * Retry receipts are persistent; failed hours cool down rather than blocking a view.
 */
export async function refineVisible({
  timestamps,
  onBusy = () => {},
  ...options
}: Omit<Parameters<typeof refineHistory>[0], "windows"> & {
  timestamps: () => number[];
  onBusy?: (busy: boolean) => void;
}) {
  const retryAt = new Map<number, number>();
  while (!options.signal.aborted) {
    const end = options.availableThrough?.epochMilliseconds ?? Date.now();
    const hours = [
      ...new Set(
        timestamps()
          .filter((t) => Number.isFinite(t) && t < end)
          .map((t) => Math.floor(t / HOUR) * HOUR),
      ),
    ].sort((a, b) => b - a);
    const visible = new Set(hours);
    for (const hour of retryAt.keys())
      if (!visible.has(hour)) retryAt.delete(hour);
    for (const hour of hours
      .filter(
        (h) =>
          (retryAt.get(h) ?? 0) <= Date.now() &&
          !options.store.windowDone(h, Math.min(h + HOUR, end), false),
      )
      .slice(0, 4)) {
      if (options.signal.aborted) return;
      const stop = Math.min(hour + HOUR, end);
      if (options.store.windowDone(hour, stop, false)) continue;
      onBusy(true);
      try {
        await refineHistory({ ...options, windows: [frame(hour, stop)] });
      } catch (err) {
        if (!options.signal.aborted) options.onError?.(err);
      } finally {
        onBusy(false);
      }
      // Also back off when a provider returns empty despite the visible evidence.
      retryAt.set(hour, Date.now() + 60_000);
    }
    await sleep(2000, undefined, { signal: options.signal }).catch(() => {});
  }
}
