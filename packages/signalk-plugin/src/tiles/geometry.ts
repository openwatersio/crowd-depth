// The grid's cells and the chart's tiles. Cells are the grid's 2/3″ surface pixels
// (packages/grid/src/grid/cells.py and surface.py): rows of 2/3″ of latitude, columns
// widened by latitude band so cells stay roughly square. Tiles are Web Mercator XYZ.
import definitions from "../definitions.json" with { type: "json" };

export const DEFINITIONS = definitions;

/** Base rows per degree, and the surface's pixel: two base rows, two base columns. */
const BASE = definitions.cells.rows_per_degree;
const PIXEL_BASE = 2;
const ROWS_PER_DEGREE = BASE / PIXEL_BASE;
const STEPS = definitions.cells.column_steps_divide;
const DIVISORS = Array.from({ length: STEPS }, (_, i) => i + 1).filter(
  (d) => STEPS % d === 0,
);

/** Column width in base steps for the 1° band whose southern edge is `lat0`, as the
 * grid's `k_for`. */
export function columnSteps(lat0: number): number {
  const want = Math.max(
    1,
    Math.round(1 / Math.cos(((lat0 + 0.5) * Math.PI) / 180)),
  );
  return DIVISORS.find((d) => d >= want) ?? STEPS;
}

/** Degrees of longitude per cell in the band holding `py`. */
function cellWidth(py: number): number {
  return (columnSteps(Math.floor(py / ROWS_PER_DEGREE)) * PIXEL_BASE) / BASE;
}

/** The cell holding a position: row and column, both counted from 0°. */
export function cellAt(lon: number, lat: number): { py: number; px: number } {
  const py = Math.floor(lat * ROWS_PER_DEGREE);
  return { py, px: Math.floor(lon / cellWidth(py)) };
}

/** A cell's centre. */
export function cellCenter(
  py: number,
  px: number,
): { lon: number; lat: number } {
  return {
    lat: (py + 0.5) / ROWS_PER_DEGREE,
    lon: (px + 0.5) * cellWidth(py),
  };
}

/** The 3×3 cells around a cell, itself included. Neighbours across a band edge are
 * found by position, since the column width changes there. */
export function neighbours(
  py: number,
  px: number,
): { py: number; px: number }[] {
  const { lon, lat } = cellCenter(py, px);
  const w = cellWidth(py);
  const out: { py: number; px: number }[] = [];
  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      out.push(
        dy === 0
          ? { py, px: px + dx }
          : cellAt(lon + dx * w, lat + dy / ROWS_PER_DEGREE),
      );
    }
  }
  return out;
}

/** Rows and columns of cells overlapping a lon/lat box, band by band. */
export function cellRanges(
  west: number,
  south: number,
  east: number,
  north: number,
): { py0: number; py1: number; px0: number; px1: number }[] {
  const ranges = [];
  const py0 = Math.floor(south * ROWS_PER_DEGREE);
  const py1 = Math.floor(north * ROWS_PER_DEGREE);
  for (let lat0 = Math.floor(south); lat0 <= Math.floor(north); lat0++) {
    const lo = Math.max(py0, lat0 * ROWS_PER_DEGREE);
    const hi = Math.min(py1, (lat0 + 1) * ROWS_PER_DEGREE - 1);
    if (lo > hi) continue;
    const w = cellWidth(lo);
    ranges.push({
      py0: lo,
      py1: hi,
      px0: Math.floor(west / w),
      px1: Math.floor(east / w),
    });
  }
  return ranges;
}

const EARTH_M = 6378137;

/** A tile's bounds in degrees. */
export function tileBounds(z: number, x: number, y: number) {
  const n = 2 ** z;
  const lat = (t: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: lat(y),
    south: lat(y + 1),
  };
}

/** Fractional tile coordinates of a position at zoom z. */
export function tileFraction(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  };
}

/** Ground metres per tile at zoom z and a latitude. */
export function tileMetres(z: number, lat: number): number {
  return ((2 * Math.PI * EARTH_M) / 2 ** z) * Math.cos((lat * Math.PI) / 180);
}

/** Metres per degree of latitude, and of longitude at a latitude. */
export const M_PER_DEG_LAT = 110540;
export function mPerDegLon(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}
