import { Writable } from "stream";
import { Temporal } from "@js-temporal/polyfill";
import { BathymetryData } from "../types.js";
import { trackQC, type Sounding } from "../qc.js";
import { CellStore, Pass, Shoal } from "./cells.js";
import { DEFINITIONS, cellAt, cellCenter, neighbours } from "./geometry.js";

const QC = DEFINITIONS.qc;

/** How long passes are batched before their cells are written, which keeps writes to
 * an SD card low. Provisional soundings show on the chart meanwhile. */
export const DEFAULT_FLUSH_MS = 10_000;

/** Soundings after the newest one QC can judge: the spike and noise checks look this
 * far ahead along the track. */
const LOOKAHEAD = Math.max(QC.spike_window, QC.noise_window) + 1;

/** Track QC looks back over: the stuck-sounder check's distance with some to spare, and
 * at least this many soundings, at most the cap, which a 10 Hz sounder reaches in about
 * half an hour. */
const HISTORY_M = QC.flat_m * 1.5;
const HISTORY_MIN = 1000;
const HISTORY_MAX = 20_000;

/** A run of one depth still going is held until it covers the stuck-sounder check's
 * distance, so QC judges it whole, as the grid does, or until it's this old: a boat at
 * a mooring, whose depth honestly holds. */
const RUN_MAX_US = 3600 * 1_000_000;

/** Soundings judged at a time past the lookahead: few live, so provisional soundings
 * settle within seconds, and more during a backfill. QC reruns over the whole buffer
 * each time, so the batch grows with it, keeping the cost per sounding bounded. */
const LIVE_BATCH = 10;
const BULK_BATCH = 200;
const BATCH_PER_BUFFER = 0.01;

/** The longest the writer keeps passes back for a backfill that hasn't finished. */
const HOLD_MAX_MS = 30 * 60_000;

/** Passes a backfill writes at a time, so each write holds the event loop briefly. */
const BULK_FLUSH_PASSES = 2000;

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

/** Readings QC rejects as bad data rather than a bad depth: no reading, an impossible
 * time, or a position that jumped. Everything else QC sets aside still shows on the live
 * layer, as an unconfirmed sounding outside the surface, so the boat sees what it
 * measured, however doubtful. */
const UNUSABLE = new Set(["sentinel", "time", "jump"]);

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
  depths: number[];
  soundings: Sounding[];
  sounded: boolean;
  first: number;
  last: number;
}

/**
 * The live layer's pipeline from corrected soundings to cells: the grid's track QC on a
 * rolling buffer, a pass per cell, and each pass's median folded into its cell's moving
 * average (docs/plans/global-grid/live-layer.md).
 *
 * A sounding is judged once the soundings QC looks ahead over have arrived and it isn't
 * in a run of one depth that's still going, which the stuck-sounder check could yet
 * flag. Bad data is dropped, other soundings QC sets aside are stored as unconfirmed, and accepted
 * ones go to the pass of every cell within a pixel. A cell's pass ends when the boat's
 * soundings leave its 3×3, and a cell gets a pass only where the boat sounded it itself.
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
    onChange = () => {},
  }: {
    flushIntervalMs?: number;
    bulk?: boolean;
    onChange?: (changed: Changed) => void;
  } = {},
) {
  let buffer: Sounding[] = [];
  /** Track metres from the buffer's start to each of its soundings. */
  let path: number[] = [];
  let judged = 0;
  const open = new Map<string, OpenPass>();
  let passes: Pass[] = [];
  let unwritten: Sounding[] = [];
  let shoals: Shoal[] = [];
  let latest = 0;
  let held = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  const closePass = (k: string, pass: OpenPass) => {
    open.delete(k);
    if (pass.sounded) {
      unwritten.push(...pass.soundings);
      passes.push({
        py: pass.py,
        px: pass.px,
        depth: median(pass.depths),
        day: Math.floor(pass.last / 86_400_000_000),
      });
    }
  };

  const accept = (s: Sounding) => {
    const at = cellAt(s.lon, s.lat);
    const near = new Set<string>();
    for (const n of neighbours(at.py, at.px)) {
      const k = key(n);
      near.add(k);
      let pass = open.get(k);
      if (
        pass &&
        (s.time - pass.last > OTHER_PASS_US ||
          s.time - pass.first > MAX_PASS_US ||
          pass.depths.length >= MAX_PASS_DEPTHS)
      ) {
        closePass(k, pass);
        pass = undefined;
      }
      if (!pass) {
        pass = {
          ...n,
          depths: [],
          soundings: [],
          sounded: false,
          first: s.time,
          last: s.time,
        };
        open.set(k, pass);
      }
      pass.depths.push(s.depth);
      pass.last = s.time;
      if (n.py === at.py && n.px === at.px) {
        pass.sounded = true;
        pass.soundings.push(s);
      }
    }
    for (const [k, pass] of open) if (!near.has(k)) closePass(k, pass);
  };

  /** Judge what QC can, or everything when `all`. */
  const judge = (all = false) => {
    if (buffer.length === 0) return;
    let end = all ? buffer.length : Math.max(judged, buffer.length - LOOKAHEAD);
    if (!all) {
      // A run of one depth reaching the newest sounding may yet be a stuck sounder.
      const n = buffer.length - 1;
      let run = n;
      while (run > 0 && buffer[run - 1].depth === buffer[n].depth) run--;
      const whole =
        path[n] - path[run] >= QC.flat_m ||
        buffer[n].time - buffer[run].time >= RUN_MAX_US ||
        n - run >= HISTORY_MAX / 2;
      if (!whole) end = Math.min(end, run);
    }
    if (end <= judged) return;
    const flags = new Map<number, string>();
    const unusable = new Set<number>();
    for (const [i, flag, reason] of trackQC(buffer, Date.now() * 1000, QC)) {
      const was = flags.get(i);
      if (was === undefined || RANK[flag] > RANK[was]) flags.set(i, flag);
      if (UNUSABLE.has(reason)) unusable.add(i);
    }
    for (let i = judged; i < end; i++) {
      const s = buffer[i];
      const flag = flags.get(i);
      if (flag === undefined || flag === "review") accept(s);
      else if (!unusable.has(i)) shoals.push(s);
    }
    judged = end;
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
    }
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
      passes = [];
      shoals = [];
      const cells = store.addPasses(batch);
      if (found.length) store.addShoals(found);
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
      try {
        judge(true);
        for (const [k, pass] of [...open]) closePass(k, pass);
        held = false;
        flush();
        callback();
      } catch (err) {
        callback(err as Error);
      }
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
      flush();
    } catch (err) {
      writer.destroy(err as Error);
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
    /** Soundings not yet in a stored cell: unjudged, or in a pass still open. */
    provisional(): Sounding[] {
      return [
        ...unwritten,
        ...[...open.values()].flatMap((p) => p.soundings),
        ...buffer.slice(judged),
      ];
    },
  });
}
