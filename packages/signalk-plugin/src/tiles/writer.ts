import { Writable } from "stream";
import { Temporal } from "@js-temporal/polyfill";
import { BathymetryData } from "../types.js";
import { trackQC, type Sounding as QCSounding } from "../qc.js";
import { CellStore, Pass, Shoal } from "./cells.js";
import type { QCRunner } from "./qc-thread.js";
import { DEFINITIONS, cellAt, cellCenter, neighbours } from "./geometry.js";
import { Tide } from "./tide.js";

/** A sounding with its tide, where it has one. QC judges its raw depth. */
export type Sounding = QCSounding & { tide?: Tide };

/** A sounding's depth below chart datum where it's tided, and its raw depth where not. */
export const charted = (s: Sounding) => s.depth - (s.tide?.level ?? 0);

const QC = DEFINITIONS.qc;

/** How long passes are batched before their cells are written, which keeps writes to
 * an SD card low. Provisional soundings show on the chart meanwhile. */
export const DEFAULT_FLUSH_MS = 10_000;

/** Soundings after the newest one QC can judge: the spike and noise checks look this
 * far ahead along the track. */
const LOOKAHEAD = Math.max(QC.spike_window, QC.noise_window) + 1;

/** Track QC looks back over: the stuck-sounder check's distance with some to spare, and
 * at least this many soundings, at most the cap, a little over an hour of a 10 Hz
 * sounder, so a boat at anchor reaches {@link RUN_MAX_US} first. */
const HISTORY_M = QC.flat_m * 1.5;
const HISTORY_MIN = 1000;
const HISTORY_MAX = 40_000;

/** Judged soundings folded into passes per write, at most. */
const FOLD_CHUNK = 2000;

/** A run of one depth still going is held until it covers the stuck-sounder check's
 * distance, so QC judges it whole, as the grid does, or until it's this old with the boat
 * still within the check's span of where the run began: a boat at a mooring, whose depth
 * honestly holds. */
const RUN_MAX_US = 3600 * 1_000_000;

/** Soundings judged at a time past the lookahead: few live, so provisional soundings
 * settle within seconds, and more during a backfill. QC reruns over the whole buffer
 * each time, so the batch grows with it, keeping the cost per sounding bounded. */
const LIVE_BATCH = 10;
const BULK_BATCH = 200;
const BATCH_PER_BUFFER = 0.01;

/** QC runs in a row that may fail on their thread before QC moves to this one, and for
 * how long before the thread is tried again. */
const MAX_QC_FAILURES = 3;
const QC_RETRY_MS = 10 * 60_000;

/** Flushes in a row that may fail before the writer gives up. */
const MAX_FLUSH_FAILURES = 3;

/** How long a written sounding is listed as stored, which covers the chart's slowest
 * tile refresh, every 30 s. */
const STORED_MS = 90_000;

/** The longest the writer keeps passes back for a backfill that hasn't finished. */
const HOLD_MAX_MS = 3 * 3600_000;

/** Passes a backfill writes at a time, so each transaction holds the database's write
 * lock, which the plugin's own sounding log waits on, only briefly. */
const BULK_FLUSH_PASSES = 250;

/** Metres between two soundings, equirectangular, as QC measures. */
function metres(a: Sounding, b: Sounding): number {
  const dx =
    (((b.lon - a.lon + 540) % 360) - 180) *
    Math.cos((a.lat * Math.PI) / 180) *
    111320;
  const dy = (b.lat - a.lat) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

/** A sounding of the same boat this long after its last in a cell is another pass, as
 * the grid's `OTHER_PASS`. */
const OTHER_PASS_US = 4 * 3600 * 1_000_000;

/** A pass is closed after this long or this many depths, so a boat at anchor or a berth
 * folds its water in as a pass every few minutes instead of holding it for days. */
const MAX_PASS_US = 10 * 60 * 1_000_000;
const MAX_PASS_DEPTHS = 600;

/** QC flags by precedence: a sounding takes its strongest. `review` alone (a reading
 * under 0.5 m) is kept, as the grid keeps it in cells. */
const RANK: Record<string, number> = {
  review: 0,
  noisy: 1,
  unconfirmed: 2,
  reject: 3,
};

/** Meta key for the time the cells hold every sounding through. */
export const THROUGH_KEY = "through";

export function getThrough(store: CellStore): Temporal.Instant | undefined {
  const value = store.getMeta(THROUGH_KEY);
  return value ? Temporal.Instant.from(value) : undefined;
}

/** Advance the marker, never past now, so a sounding from a clock set in the future
 * can't make later backfills skip real time. */
export function setThrough(store: CellStore, micros: number) {
  const now = Temporal.Now.instant();
  let instant = Temporal.Instant.fromEpochMilliseconds(
    Math.floor(micros / 1000),
  );
  if (Temporal.Instant.compare(instant, now) > 0) instant = now;
  const current = getThrough(store);
  if (!current || Temporal.Instant.compare(instant, current) > 0) {
    store.setMeta(THROUGH_KEY, instant.toString());
  }
}

/** Positions the cells or shoals changed at, for the tiles to refresh. */
export type Changed = { lon: number; lat: number }[];

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const key = (c: { py: number; px: number }) => `${c.py},${c.px}`;

/** A pass through one cell: the depths within a pixel of it, and the soundings in it,
 * which draw as provisional until the pass is stored. */
interface OpenPass {
  py: number;
  px: number;
  /** Depths reduced to chart datum, with the largest tide σ among them, and raw depths
   * of soundings without a tide, used only where the pass has no reduced ones: one pass
   * never mixes the two references. */
  depths: number[];
  tide: number;
  raw: number[];
  soundings: Sounding[];
  sounded: boolean;
  first: number;
  last: number;
}

/**
 * The live layer's pipeline from corrected soundings to cells: the grid's track QC on a
 * buffer of recent soundings, a pass per cell, and each pass's median folded into its
 * cell's moving average (docs/plans/global-grid/live-layer.md).
 *
 * A sounding is judged once the soundings QC looks ahead over have arrived and it isn't
 * in a run of one depth that's still going, which the stuck-sounder check could yet
 * flag. Rejected and deep-side soundings are dropped, shoal-side ones QC doubts are
 * stored as unconfirmed shoals, and accepted ones go to the pass of every cell within a
 * pixel. A cell's pass ends when the boat's soundings leave its 3×3, and a cell gets a
 * pass only where the boat sounded it itself.
 *
 * Passes are written every {@link DEFAULT_FLUSH_MS}, and the {@link THROUGH_KEY} marker
 * moves to the oldest sounding still held, so a restart backfills what was held. A pass
 * that was stored before the restart and is backfilled again counts twice: the average
 * stays, and its deviation narrows a little, so the margin does too.
 *
 * While {@link hold} is on, as while a backfill is found and runs, passes are kept rather
 * than written, so older passes go into the cells before newer ones; after
 * {@link HOLD_MAX_MS} they're written anyway.
 */
export function createCellWriter(
  store: CellStore,
  {
    flushIntervalMs = DEFAULT_FLUSH_MS,
    bulk = false,
    overviews = true,
    onChange = () => {},
    qc: runQC,
    onError = () => {},
  }: {
    flushIntervalMs?: number;
    bulk?: boolean;
    /** Keep the overviews up as passes are written; a backfill rebuilds them after. */
    overviews?: boolean;
    onChange?: (changed: Changed) => void;
    /** Where track QC runs, as on a thread of its own; without it, here. */
    qc?: QCRunner;
    /** Told of trouble the writer goes on through. */
    onError?: (err: Error) => void;
  } = {},
) {
  /** While QC's thread has failed, when to try it again. */
  let qcDownUntil = 0;
  let buffer: Sounding[] = [];
  /** Track metres from the buffer's start to each of its soundings. */
  let path: number[] = [];
  let judged = 0;
  /** The buffer's first sounding, counted from the writer's first. */
  let base = 0;
  /** QC's verdicts on soundings judged but not yet all folded in, from sounding `at`. */
  let ruled: { at: number; flags: (string | undefined)[] } | undefined;
  /** QC running on its thread; nothing is judged or trimmed meanwhile. */
  let running: Promise<void> | undefined;
  let qcFailures = 0;
  const open = new Map<string, OpenPass>();
  let passes: Pass[] = [];
  let unwritten: Sounding[] = [];
  /** Soundings written in the last {@link STORED_MS}, by time, and when. */
  let stored: { id: number; at: number }[] = [];
  let shoals: Shoal[] = [];
  let latest = 0;
  let held = false;
  let failures = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  const closePass = (k: string, pass: OpenPass) => {
    open.delete(k);
    if (pass.sounded) {
      unwritten.push(...pass.soundings);
      passes.push({
        py: pass.py,
        px: pass.px,
        day: Math.floor(pass.last / 86_400_000_000),
        ...(pass.depths.length
          ? { depth: median(pass.depths), tide: pass.tide }
          : { depth: median(pass.raw) }),
      });
    }
  };

  const accept = (s: Sounding) => {
    const at = cellAt(s.lon, s.lat);
    const near = new Set<string>();
    for (const n of neighbours(at.py, at.px)) {
      const k = key(n);
      // Across a latitude band's edge two neighbours can be one cell.
      if (near.has(k)) continue;
      near.add(k);
      let pass = open.get(k);
      if (
        pass &&
        (s.time - pass.last > OTHER_PASS_US ||
          s.time - pass.first > MAX_PASS_US ||
          pass.depths.length + pass.raw.length >= MAX_PASS_DEPTHS)
      ) {
        closePass(k, pass);
        pass = undefined;
      }
      if (!pass) {
        pass = {
          ...n,
          depths: [],
          tide: 0,
          raw: [],
          soundings: [],
          sounded: false,
          first: s.time,
          last: s.time,
        };
        open.set(k, pass);
      }
      if (s.tide) {
        pass.depths.push(charted(s));
        pass.tide = Math.max(pass.tide, s.tide.sigma);
      } else {
        pass.raw.push(s.depth);
      }
      pass.last = s.time;
      if (n.py === at.py && n.px === at.px) {
        pass.sounded = true;
        pass.soundings.push(s);
      }
    }
    for (const [k, pass] of open) if (!near.has(k)) closePass(k, pass);
  };

  /** Which soundings QC can judge now, to `end`, or none. */
  const ready = (all: boolean) => {
    if (all) return buffer.length;
    let end = Math.max(judged, buffer.length - LOOKAHEAD);
    // A run of one depth reaching the newest sounding may yet be a stuck sounder.
    const n = buffer.length - 1;
    let run = n;
    while (run > 0 && buffer[run - 1].depth === buffer[n].depth) run--;
    const whole =
      path[n] - path[run] >= QC.flat_m ||
      (buffer[n].time - buffer[run].time >= RUN_MAX_US &&
        metres(buffer[run], buffer[n]) < QC.flat_span_m) ||
      buffer.length - judged >= HISTORY_MAX - HISTORY_MIN;
    if (!whole) end = Math.min(end, run);
    return end;
  };

  /** Take QC's findings over the buffer as it stood, for the soundings to `end`. */
  const rule = (
    found: readonly (readonly [number, string, ...unknown[]])[],
    end: number,
  ) => {
    const flags: (string | undefined)[] = new Array(end - judged);
    for (const [i, flag] of found) {
      const k = i - judged;
      if (k < 0 || k >= flags.length) continue;
      const was = flags[k];
      if (was === undefined || RANK[flag] > RANK[was]) flags[k] = flag;
    }
    ruled = { at: base + judged, flags };
  };

  /** Fold judged soundings in, a share at a time, or all of them. */
  const fold = (all: boolean) => {
    if (!ruled) return;
    // A long run of one depth judged at once would otherwise hold the server up while
    // thousands of soundings go into passes.
    const offset = base + judged - ruled.at;
    const count = all
      ? ruled.flags.length - offset
      : Math.min(FOLD_CHUNK, ruled.flags.length - offset);
    // Every doubtful reading on the shoal side shows, as an unconfirmed sounding outside
    // the surface: QC marks those `unconfirmed`. What it rejects or marks `noisy` is
    // bad data or the deep side, which drawn would show water deeper than it is.
    for (let k = 0; k < count; k++) {
      const s = buffer[judged + k];
      const flag = ruled.flags[offset + k];
      if (flag === undefined || flag === "review") accept(s);
      else if (flag === "unconfirmed") {
        shoals.push({
          time: s.time,
          lon: s.lon,
          lat: s.lat,
          depth: charted(s),
        });
      }
    }
    judged += count;
    if (offset + count >= ruled.flags.length) ruled = undefined;
    // Keep what QC looks back over, and everything not yet judged.
    const n = buffer.length - 1;
    let drop = 0;
    while (
      drop < judged &&
      n - drop > HISTORY_MIN &&
      (path[n] - path[drop] > HISTORY_M || n - drop > HISTORY_MAX)
    ) {
      drop++;
    }
    if (drop > 0) {
      buffer = buffer.slice(drop);
      path = path.slice(drop);
      judged -= drop;
      base += drop;
    }
  };

  /** Judge what QC can, or everything when `all`, which runs QC here. */
  const judge = (all = false) => {
    if (ruled) return fold(all);
    if (running || buffer.length === 0) return;
    const end = ready(all);
    if (end <= judged) return;
    const arrival = Date.now() * 1000;
    const qc = Date.now() >= qcDownUntil ? runQC : undefined;
    if (!qc || all) {
      rule(trackQC(buffer, arrival, QC), end);
      return fold(all);
    }
    // On its thread: the buffer only grows until the findings are back, so their
    // indexes still hold.
    // A thread that can't start throws here, which counts as a failed run.
    let asked: ReturnType<QCRunner>;
    try {
      asked = qc(buffer, arrival);
    } catch (err) {
      asked = Promise.reject(err as Error);
    }
    running = asked.then(
      (found) => {
        running = undefined;
        qcFailures = 0;
        if (writer.destroyed) return;
        try {
          rule(found, end);
          fold(false);
        } catch (err) {
          writer.destroy(err as Error);
        }
      },
      (err: Error) => {
        // The thread starts again on the next run; QC moves here for a while if it
        // keeps failing.
        running = undefined;
        if (++qcFailures < MAX_QC_FAILURES) return;
        qcFailures = 0;
        qcDownUntil = Date.now() + QC_RETRY_MS;
        onError(
          new Error(
            `QC thread failed, running QC on the server's for ${QC_RETRY_MS / 60_000} minutes: ${err}`,
          ),
        );
      },
    );
  };

  /** The oldest sounding not yet written, or Infinity. */
  const oldestHeld = () => {
    let oldest = Infinity;
    for (let i = judged; i < buffer.length; i++) {
      oldest = Math.min(oldest, buffer[i].time);
    }
    for (const s of unwritten) oldest = Math.min(oldest, s.time);
    for (const p of open.values()) {
      for (const s of p.soundings) oldest = Math.min(oldest, s.time);
    }
    return oldest;
  };

  const flush = () => {
    if (held) return;
    if (passes.length || shoals.length) {
      const batch = passes;
      const found = shoals;
      // Taken only once written, so a write that fails is tried again whole. Shoals
      // first: writing one again changes nothing, where a pass would count twice.
      if (found.length) store.addShoals(found);
      const cells = store.addPasses(batch, overviews);
      passes = passes.slice(batch.length);
      shoals = shoals.slice(found.length);
      if (!bulk) {
        const at = Date.now();
        stored = stored.filter((s) => s.at >= at - STORED_MS);
        for (const s of [...unwritten, ...found])
          stored.push({ id: s.time, at });
      }
      unwritten = [];
      onChange([...cells.map((c) => cellCenter(c.py, c.px)), ...found]);
    }
    if (!bulk && latest) {
      const oldest = oldestHeld();
      setThrough(store, Number.isFinite(oldest) ? oldest - 1 : latest);
    }
  };

  const writer = new Writable({
    objectMode: true,
    write(data: BathymetryData, _encoding, callback) {
      try {
        const time = Number(data.timestamp.epochMilliseconds) * 1000;
        const s = {
          time,
          lon: data.longitude,
          lat: data.latitude,
          depth: data.depth,
          tide: data.tide,
        };
        const prev = buffer[buffer.length - 1];
        path.push(prev ? path[path.length - 1] + metres(prev, s) : 0);
        buffer.push(s);
        latest = Math.max(latest, time);
        const batch = Math.max(
          bulk ? BULK_BATCH : LIVE_BATCH,
          buffer.length * BATCH_PER_BUFFER,
        );
        if (buffer.length - judged >= LOOKAHEAD + batch) judge();
        if (bulk && passes.length >= BULK_FLUSH_PASSES) flush();
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    final(callback) {
      clearInterval(timer);
      clearTimeout(holdTimer);
      void (running ?? Promise.resolve())
        .catch(() => {})
        .then(() => {
          try {
            // A run part folded in finishes first; then the rest is judged.
            while (judged < buffer.length) judge(true);
            for (const [k, pass] of [...open]) closePass(k, pass);
            held = false;
            flush();
            callback();
          } catch (err) {
            callback(err as Error);
          }
        });
    },
    // A pipeline destroys its writer on abort, which doesn't run `final`. Passes already
    // closed are written; what's held is left for the next start's backfill.
    destroy(error, callback) {
      clearInterval(timer);
      clearTimeout(holdTimer);
      try {
        flush();
      } catch {
        // The store failed or is gone; the marker wasn't advanced.
      }
      callback(error);
    },
  });

  const timer = setInterval(() => {
    try {
      // A sounder gone quiet, at a berth or switched off, would leave its last passes
      // open for good.
      // Live only: a backfill's soundings are all old.
      const now = Date.now() * 1000;
      // Verdicts not yet folded in, which only writes otherwise fold.
      if (ruled) fold(false);
      for (const [k, pass] of bulk ? [] : [...open]) {
        if (now - pass.last > MAX_PASS_US) closePass(k, pass);
      }
      flush();
      failures = 0;
    } catch (err) {
      // A busy or briefly failing database is tried again next time; one that keeps
      // failing ends the writer.
      if (++failures >= MAX_FLUSH_FAILURES) writer.destroy(err as Error);
    }
  }, flushIntervalMs);
  timer.unref?.();

  const hold = (on: boolean) => {
    held = on;
    clearTimeout(holdTimer);
    if (on) {
      holdTimer = setTimeout(() => hold(false), HOLD_MAX_MS);
      holdTimer.unref?.();
    } else {
      flush();
    }
  };

  return Object.assign(writer, {
    /** Keep passes rather than write them, or write what was kept. */
    hold,
    /** The soundings written to the store lately: still to show until the chart's tiles
     * have caught up with them. */
    stored(): number[] {
      const since = Date.now() - STORED_MS;
      stored = stored.filter((s) => s.at >= since);
      return stored.map((s) => s.id);
    },
    /** Soundings not yet in a stored cell: unjudged, in a pass still open, or held. */
    provisional(): Sounding[] {
      return [
        ...unwritten,
        ...shoals,
        ...[...open.values()].flatMap((p) => p.soundings),
        ...buffer.slice(judged),
      ];
    },
  });
}
