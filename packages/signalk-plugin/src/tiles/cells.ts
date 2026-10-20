import { DatabaseSync } from "node:sqlite";
import { DEFINITIONS, cellAt, cellRanges } from "./geometry.js";

/** Overview levels: blocks of 2^level cells a side (about 41 m, 82 m, 330 m and 1.3 km),
 * each holding its shoalest cell, so a zoomed-out tile reads a row per block rather
 * than every cell under it. */
export const OVERVIEW_LEVELS = [1, 2, 4, 6];
const ROWS_PER_BAND = DEFINITIONS.cells.rows_per_degree / 2;
/** Overview rows a rebuild writes per transaction. */
const REBUILD_ROWS = 2000;

/** An overview block's key. Blocks stay within a 1° band, whose columns are its own. */
function block(py: number, px: number, level: number) {
  const band = Math.floor(py / ROWS_PER_BAND);
  const blocks = Math.ceil(ROWS_PER_BAND / 2 ** level);
  return {
    oy: band * blocks + ((py - band * ROWS_PER_BAND) >> level),
    ox: px >> level,
  };
}

/** Weight of each new pass in a cell's moving average (docs/plans/global-grid/live-layer.md). */
export const ALPHA = 0.2;
/** A cell's absolute deviation before its second pass, in metres. */
export const FIRST_DEVIATION_M = 0.3;
/** 1.25 × the mean absolute deviation estimates a standard deviation. */
const DEVIATION_TO_SIGMA = 1.25;

const { k, untided_sigma_m, uncalibrated_sigma_m } = DEFINITIONS.statistic;

/** One cell's running estimate: the moving average of its pass medians and of their
 * absolute deviation, in metres, how many passes it has had, and the days (since the
 * epoch) of its first and last. A tided cell has `t`, the moving average of its passes'
 * tide σ; an untided cell has none, and its depths are on the sounder's own reference
 * rather than chart datum. */
export interface Cell {
  py: number;
  px: number;
  m: number;
  d: number;
  t?: number;
  /** An overview block with an untided cell among its cells, whatever its shoalest. */
  untidedBelow?: boolean;
  passes: number;
  first: number;
  last: number;
}

/** A pass's median depth in one cell, reduced to chart datum when it has `tide`, the
 * largest tide σ of its soundings. */
export interface Pass {
  py: number;
  px: number;
  depth: number;
  day: number;
  tide?: number;
}

/** A sounding QC kept as an unconfirmed shoal: published, never in the surface. */
export interface Shoal {
  lon: number;
  lat: number;
  depth: number;
  time: number;
}

/** σ of a cell's estimate: its passes' spread with the correction uncertainty, the
 * tide's where it's tided. */
export function cellSigma(cell: Pick<Cell, "d" | "t">): number {
  return Math.hypot(
    cell.t ?? untided_sigma_m,
    uncalibrated_sigma_m,
    DEVIATION_TO_SIGMA * cell.d,
  );
}

/** A cell's published depth, `m − kσ`. The margin never makes wet water drying. */
export function cellDepth(cell: Pick<Cell, "m" | "d" | "t">): number {
  const depth = cell.m - k * cellSigma(cell);
  return cell.m >= 0 ? Math.max(0, depth) : depth;
}

/** Fold one pass into a cell's estimate, as m ← m + α(x − m), d ← d + α(|x − m| − d).
 *
 * A tided pass starts an untided cell afresh: its passes are on another reference. An
 * untided pass leaves a tided cell as it was: the water has a station, so the pass is
 * waiting on a level it didn't get, as when signalk-tides stopped, and its raw depth
 * would read deeper than chart datum whenever the tide is above it. The grid holds such
 * soundings out the same way (`awaiting_tide`). */
export function addPass(cell: Cell | undefined, pass: Pass): Cell {
  if (cell?.t !== undefined && pass.tide === undefined) return cell;
  if (!cell || (cell.t === undefined && pass.tide !== undefined)) {
    return {
      py: pass.py,
      px: pass.px,
      m: pass.depth,
      d: FIRST_DEVIATION_M,
      ...(pass.tide !== undefined && { t: pass.tide }),
      passes: 1,
      first: pass.day,
      last: pass.day,
    };
  }
  return {
    ...cell,
    d: cell.d + ALPHA * (Math.abs(pass.depth - cell.m) - cell.d),
    m: cell.m + ALPHA * (pass.depth - cell.m),
    ...(cell.t !== undefined &&
      pass.tide !== undefined && {
        t: cell.t + ALPHA * (pass.tide - cell.t),
      }),
    passes: cell.passes + 1,
    first: Math.min(cell.first, pass.day),
    last: Math.max(cell.last, pass.day),
  };
}

export type CellStore = ReturnType<typeof createCellStore>;

/** A cell as stored, in centimetres, with an untided cell's t NULL; an overview block's
 * also has `u`, 1 where any of its cells is untided. */
type Row = Omit<Cell, "t" | "untidedBelow"> & { t: number | null; u?: number };

/**
 * The live layer's cells and unconfirmed shoals, in the plugin's own database (tables
 * created by a migration in storage.ts), beside the raw `bathymetry` sounding log they're
 * built from. A cell's state doesn't grow with its passes: it's one row however often the
 * boat crosses it, so the store grows with the water the boat has covered, not with time.
 *
 * Each overview level keeps the shoalest cell of each of its blocks, exactly: a cell
 * shoaler than its block's takes its place, and when the block's own cell deepens, the
 * block is found again from its cells.
 *
 * ponytail: one row per cell and per overview block, about 75 bytes a cell in SQLite. A
 * blob per block of cells would bring the busiest boat's 1.5M cells from about 114 MB
 * toward the raw 12 MB.
 */
export function createCellStore(db: DatabaseSync) {
  const readCell = db.prepare(
    "SELECT m, d, t, passes, first, last FROM cells WHERE py = ? AND px = ?",
  );
  const writeCell = db.prepare(
    `INSERT INTO cells(py, px, m, d, t, passes, first, last) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(py, px) DO UPDATE SET m = excluded.m, d = excluded.d, t = excluded.t,
       passes = excluded.passes, first = excluded.first, last = excluded.last`,
  );
  // One row of cells or blocks at a time: the key ranges only on its first column, so
  // a box over many rows would read each row across every longitude.
  const rowCells = db.prepare(
    `SELECT py, px, m, d, t, passes, first, last FROM cells
     WHERE py = ? AND px BETWEEN ? AND ?`,
  );
  const readBlock = db.prepare(
    `SELECT py, px, m, d, t, passes, first, last, u FROM overviews
     WHERE level = ? AND oy = ? AND ox = ?`,
  );
  const writeBlock = db.prepare(
    `INSERT INTO overviews(level, oy, ox, py, px, m, d, t, passes, first, last, u)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(level, oy, ox) DO UPDATE SET py = excluded.py, px = excluded.px,
       m = excluded.m, d = excluded.d, t = excluded.t, u = excluded.u, passes = excluded.passes,
       first = excluded.first, last = excluded.last`,
  );
  const rowBlocks = db.prepare(
    `SELECT py, px, m, d, t, passes, first, last, u FROM overviews
     WHERE level = ? AND oy = ? AND ox BETWEEN ? AND ?`,
  );
  // The shoalest per cell; a sounding read again at the same depth changes nothing.
  const insertShoal = db.prepare(
    `INSERT INTO shoals(py, px, lon, lat, depth, time) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(py, px) DO UPDATE SET lon = excluded.lon, lat = excluded.lat,
       depth = excluded.depth, time = excluded.time
     WHERE excluded.depth < shoals.depth`,
  );
  // One range per latitude band: shoals are one per cell at most, so reading a band's
  // rows across every longitude stays small, and a zoomed-out tile makes a query per
  // band rather than per row.
  const bandShoals = db.prepare(
    `SELECT lon, lat, depth, time FROM shoals
     WHERE py BETWEEN ? AND ? AND px BETWEEN ? AND ?`,
  );
  const getMetaStmt = db.prepare("SELECT value FROM tile_meta WHERE key = ?");
  const setMetaStmt = db.prepare(
    `INSERT INTO tile_meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  // Stored in centimetres: m and d each fit in 2 bytes for depths to 327 m, and SQLite
  // stores small integers in as many bytes as they need. All round toward shoal: m
  // down and d and t, which widen the margin, up. Rounded each pass, m settles up to
  // 5 cm shoaler than its passes and d as much wider. An untided cell's t is NULL.
  const cmDown = (m: number) => Math.floor(m * 100 + 1e-6);
  const cmUp = (m: number) => Math.ceil(m * 100 - 1e-6);
  const fromRow = (row: Row): Cell => {
    const { t, u, ...rest } = row;
    return {
      ...rest,
      m: row.m / 100,
      d: row.d / 100,
      ...(t !== null && { t: t / 100 }),
      ...(u && { untidedBelow: true }),
    };
  };
  const write = (
    stmt: { run: (...v: (number | null)[]) => unknown },
    pre: number[],
    c: Cell,
    post: number[] = [],
  ) =>
    stmt.run(
      ...pre,
      c.py,
      c.px,
      cmDown(c.m),
      cmUp(c.d),
      c.t === undefined ? null : cmUp(c.t),
      c.passes,
      c.first,
      c.last,
      ...post,
    );
  const rows = (
    py0: number,
    py1: number,
    read: (py: number) => unknown[],
  ): Cell[] => {
    const out: Cell[] = [];
    for (let py = py0; py <= py1; py++) {
      for (const row of read(py) as Row[]) out.push(fromRow(row));
    }
    return out;
  };

  /** Keep each level's shoalest cell of the block holding `cell`. */
  const updateBlocks = (cell: Cell) => {
    // Compared as stored, in centimetres.
    const depth = cellDepth({
      m: cmDown(cell.m) / 100,
      d: cmUp(cell.d) / 100,
      t: cell.t === undefined ? undefined : cmUp(cell.t) / 100,
    });
    for (const level of OVERVIEW_LEVELS) {
      const { oy, ox } = block(cell.py, cell.px, level);
      const row = readBlock.get(level, oy, ox) as Row | undefined;
      const was = row && fromRow(row);
      // Only ever set here: a block whose untided cell became tided says untided until
      // the overviews are rebuilt, which is the safe side.
      const u = [was?.untidedBelow || cell.t === undefined ? 1 : 0];
      if (!was || depth <= cellDepth(was)) {
        write(writeBlock, [level, oy, ox], cell, u);
      } else if (u[0] && !was.untidedBelow) {
        write(writeBlock, [level, oy, ox], was, u);
      } else if (was.py === cell.py && was.px === cell.px) {
        // The block's shoalest cell deepened: another may now be shoalest.
        const band = Math.floor(cell.py / ROWS_PER_BAND);
        const blocks = Math.ceil(ROWS_PER_BAND / 2 ** level);
        const py0 = band * ROWS_PER_BAND + (oy - band * blocks) * 2 ** level;
        const py1 = Math.min(py0 + 2 ** level, (band + 1) * ROWS_PER_BAND) - 1;
        const px0 = ox * 2 ** level;
        let best = cell;
        let bestDepth = depth;
        const px1 = px0 + 2 ** level - 1;
        for (const c of rows(py0, py1, (py) => rowCells.all(py, px0, px1))) {
          const d = cellDepth(c);
          if (d < bestDepth) {
            best = c;
            bestDepth = d;
          }
        }
        write(writeBlock, [level, oy, ox], best, u);
      }
    }
  };

  const transaction = <T>(fn: () => T): T => {
    // IMMEDIATE takes the write lock up front, so a second connection writing at the
    // same time, the backfill's, waits for it rather than failing midway.
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Don't mask the original error.
      }
      throw err;
    }
  };

  return {
    /** Fold passes into their cells in one transaction; returns the cells written.
     * Without `overviews`, as during a backfill, the overviews are left for
     * {@link rebuildOverviews}. */
    addPasses(passes: Pass[], overviews = true): Cell[] {
      return transaction(() =>
        passes.map((pass) => {
          const row = readCell.get(pass.py, pass.px) as
            Omit<Row, "py" | "px"> | undefined;
          const cell = addPass(
            row && fromRow({ ...row, py: pass.py, px: pass.px }),
            pass,
          );
          write(writeCell, [], cell);
          if (overviews) updateBlocks(cell);
          return cell;
        }),
      );
    },

    addShoals(shoals: Shoal[]) {
      transaction(() => {
        for (const s of shoals) {
          const { py, px } = cellAt(s.lon, s.lat);
          insertShoal.run(py, px, s.lon, s.lat, s.depth, s.time);
        }
      });
    },

    /** Cells overlapping a lon/lat box, or at an overview `level` the shoalest cell of
     * each block overlapping it. */
    cells(
      west: number,
      south: number,
      east: number,
      north: number,
      level = 0,
    ): Cell[] {
      return cellRanges(west, south, east, north).flatMap((r) =>
        level
          ? rows(
              block(r.py0, r.px0, level).oy,
              block(r.py1, r.px0, level).oy,
              (oy) => rowBlocks.all(level, oy, r.px0 >> level, r.px1 >> level),
            )
          : rows(r.py0, r.py1, (py) => rowCells.all(py, r.px0, r.px1)),
      );
    },

    shoals(west: number, south: number, east: number, north: number): Shoal[] {
      return cellRanges(west, south, east, north).flatMap(
        (r) => bandShoals.all(r.py0, r.py1, r.px0, r.px1) as unknown as Shoal[],
      );
    },

    getMeta: (key: string) =>
      (getMetaStmt.get(key) as { value: string } | undefined)?.value,
    setMeta: (key: string, value: string) => {
      setMetaStmt.run(key, value);
    },
    transaction,
    clear() {
      db.exec("DELETE FROM cells; DELETE FROM overviews; DELETE FROM shoals;");
    },

    /** Find every overview block's shoalest cell again, a stretch of rows at a time,
     * each in a short transaction of its own so the plugin's other writes never wait
     * long. Stretches are 64 rows of a 1° band, the tallest block, so no block spans
     * two of them. */
    rebuildOverviews() {
      const tallest = 2 ** Math.max(...OVERVIEW_LEVELS);
      const range = db
        .prepare("SELECT min(py) AS lo, max(py) AS hi FROM cells")
        .get() as { lo: number | null; hi: number | null };
      if (range.lo === null || range.hi === null) return;
      const stretch = db.prepare(
        `SELECT py, px, m, d, t, passes, first, last FROM cells WHERE py BETWEEN ? AND ?`,
      );
      for (
        let band = Math.floor(range.lo / ROWS_PER_BAND);
        band <= Math.floor(range.hi / ROWS_PER_BAND);
        band++
      ) {
        for (let r = 0; r < ROWS_PER_BAND; r += tallest) {
          const py0 = band * ROWS_PER_BAND + r;
          if (py0 + tallest <= range.lo || py0 > range.hi) continue;
          const py1 = Math.min(py0 + tallest, (band + 1) * ROWS_PER_BAND) - 1;
          const best = new Map<
            string,
            { cell: Cell; depth: number; at: number[]; u: number }
          >();
          for (const row of stretch.all(py0, py1) as unknown as Row[]) {
            const cell = fromRow(row);
            const depth = cellDepth(cell);
            for (const level of OVERVIEW_LEVELS) {
              const { oy, ox } = block(cell.py, cell.px, level);
              const k = `${level},${oy},${ox}`;
              const was = best.get(k);
              const u = was?.u || cell.t === undefined ? 1 : 0;
              if (!was || depth < was.depth) {
                best.set(k, { cell, depth, at: [level, oy, ox], u });
              } else {
                was.u = u;
              }
            }
          }
          // Written over what's there, a couple of thousand rows a transaction, so no
          // write holds the lock for long. Nothing goes stale: a block keeps its cells,
          // which only `clear` removes, and it clears the overviews too.
          const rows = [...best.values()];
          for (let i = 0; i < rows.length; i += REBUILD_ROWS) {
            transaction(() => {
              for (const { cell, at, u } of rows.slice(i, i + REBUILD_ROWS)) {
                write(writeBlock, at, cell, [u]);
              }
            });
          }
        }
      }
    },
  };
}
