import { pipeline } from "stream/promises";
import { setImmediate } from "node:timers/promises";
import { Temporal } from "@js-temporal/polyfill";
import { transform } from "stream-transform";
import { ServerAPI } from "@signalk/server-api";
import { Config } from "../config.js";
import { BathymetrySource, Timeframe } from "../types.js";
import { correctForSensorPosition } from "../streams/index.js";
import { TileStore } from "./core/index.js";
import { createTileWriter, getThrough } from "./writer.js";

/** How far back a store with no tiles yet is filled from the plugin's source. */
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

export function getPendingBackfill(store: TileStore): Timeframe | undefined {
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
 * run again in full, ancestors included.
 */
export function addPendingBackfill(store: TileStore, until: Temporal.Instant) {
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

/** Give up on the pending span, once it is done or when the tiles are cleared. */
export function clearPendingBackfill(store: TileStore) {
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
export function recordBackfillFailure(store: TileStore): boolean {
  const failures = Number(store.getMeta(FAILURES_KEY) || 0) + 1;
  if (failures >= MAX_BACKFILL_FAILURES) {
    clearPendingBackfill(store);
    return false;
  }
  store.setMeta(FAILURES_KEY, String(failures));
  return true;
}

/**
 * Fill the tiles for the pending span from the plugin's own source (the
 * History API or its SQLite log). Soundings go through the same position
 * correction as what the plugin submits, so the chart shows what is shared.
 * The span is cleared only once the tiles and their ancestors are written.
 */
export async function backfillTiles({
  app,
  config,
  source,
  store,
  signal,
}: {
  app: ServerAPI;
  config: Config;
  source: BathymetrySource;
  store: TileStore;
  signal: AbortSignal;
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
    app.debug(`Backfilling chart tiles from ${windows.length} windows`);
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
      createTileWriter(store, { bulk: true }),
      { signal },
    );
  }
  if (!signal.aborted) clearPendingBackfill(store);
}
