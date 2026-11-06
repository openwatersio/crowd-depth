// One chart tile of the live layer, built from the cells under it: the grid's depth
// surface (packages/grid/src/grid/surface.py, docs/plans/global-grid/surface.md) and its
// S-57 overlay layers (overlay.py), for one vessel.
//
// The grid works on its 2/3″ pixels per 1° tile. A chart tile here is a square raster in
// Web Mercator of at most 256 pixels a side, sized so a pixel is about a cell (see
// `rasterSize`); zoomed out, a pixel holds the shoalest of its cells, as the grid
// aggregates. Distances are in metres, so the radius, smoothing and blur mean
// what they mean in the grid at every zoom.
import { Cell, Shoal, cellDepth, cellSigma } from "./cells.js";
import {
  DEFINITIONS,
  M_PER_DEG_LAT,
  cellCenter,
  mPerDegLon,
  tileBounds,
  tileFraction,
  tileMetres,
} from "./geometry.js";
import { EXTENT, Feature, Point, encodeTile } from "./mvt.js";
import {
  Level,
  Prepared,
  band,
  cut,
  isolines,
  polygons,
  prepare,
} from "./portray.js";

const {
  interpolation_radius_m: RADIUS_M,
  smoothing_m: SMOOTHING_M,
  blur_px,
} = DEFINITIONS.surface;
const { k: K, sigma_per_m: SIGMA_PER_M } = DEFINITIONS.statistic;
const P = DEFINITIONS.portrayal;

/** A cell's height, 2/3″ of latitude. */
export const CELL_M = (2 * M_PER_DEG_LAT) / DEFINITIONS.cells.rows_per_degree;
/** The grid's blur, a gaussian of 2 of its pixels. */
const BLUR_M = blur_px * CELL_M;
const MAX_POINTS = 12;
const MIN_POINTS = 3;
/** Areas and contours stop here, as the grid's: deeper crowd soundings are mostly
 * sounders that lost the bottom. */
const MAX_AREA_DEPTH_M = 200;
/** The deepest band's floor below chart datum, as the grid's drying band. */
const DRYING_FLOOR_M = -30;
/** How finely depths are drawn: contours every metre and every foot, or the chart's
 * isobaths. */
export type Detail = "high" | "standard";
/** The zoom fine contours start at: zoomed out further, they'd run together, and the
 * chart's isobaths are drawn. */
export const FINE_ZOOM = 13;
/** How much shoaler than a band's depths its edges are traced, so a band holds its
 * lower depth and not its upper: too little to see. */
const EDGE_M = 0.005;
/** Soundings per tile side, as the grid's lattice. */
const SOUNDINGS_PER_SIDE = 8;
/** The finest zoom built; clients overzoom past it, as the grid's overlay. */
export const MAX_ZOOM = 15;
/** How far a line may move when simplified, in tile units: half a screen pixel of a
 * 256-pixel tile. Tiles at MAX_ZOOM a quarter of that, since plotters stretch them
 * past it, where half a pixel at 15 is two at 17. */
const SIMPLIFY_UNITS = EXTENT / 256 / 2;
const SIMPLIFY_MAX_ZOOM_UNITS = SIMPLIFY_UNITS / 4;
/** Depth areas are simplified a quarter as far, and never less than a unit: two bands
 * share each edge but simplify it apart, and on a steep slope, where bands are thin, the
 * gap between them shows as a light seam. Coverage, a faint tint, is simplified as far
 * as lines: where its edge parts from the areas' by half a pixel, it doesn't show. */
const AREA_SHARE = 1 / 4;
export const MIN_ZOOM = 4;
const LEVELS = P.isobaths_m.filter((l) => l <= MAX_AREA_DEPTH_M);
/** Depths finely drawn reach as deep as this; past it, the chart's isobaths. */
const FINE_MAX_M = 50;
/** Bands finely drawn: every metre to FINE_MAX_M, then the chart's. */
const FINE_EDGES = [
  DRYING_FLOOR_M,
  ...Array.from({ length: FINE_MAX_M + 1 }, (_, m) => m),
  ...LEVELS.filter((l) => l > FINE_MAX_M),
];
/** Contours finely drawn: every metre, and every foot, each fifth one major; and the
 * drying line, in either unit. */
const FINE_CONTOURS: Level[] = [
  { m: 0 },
  ...Array.from({ length: FINE_MAX_M }, (_, k) => ({
    m: k + 1,
    unit: "m" as const,
    major: (k + 1) % 5 === 0,
  })),
  ...Array.from({ length: Math.floor(FINE_MAX_M / P.m_per_ft) }, (_, k) => ({
    m: (k + 1) * P.m_per_ft,
    unit: "ft" as const,
    major: (k + 1) % 5 === 0,
  })),
  // Deeper, the chart's, in either unit.
  ...P.isobaths_m
    .filter((l) => l > FINE_MAX_M && l <= MAX_AREA_DEPTH_M)
    .map((m) => ({ m })),
];
const POSACC_M = 10;
const TECSOU = 1;
const INFORM = {
  tided:
    "This boat's own soundings, recorded by its Crowd Depth plugin. Reduced to chart datum with predicted tides, and not calibrated. Not for navigation.",
  untided:
    "This boat's own soundings, recorded by its Crowd Depth plugin. Not reduced for tide or to chart datum, and not calibrated. Not for navigation.",
};

/** Raster sizes below SHARED_ZOOM step by this many pixels. */
const RASTER_STEP = 16;

/** Raster pixels a side for a tile centred at `lat`: at most 256, and a pixel about a
 * cell. */
export function rasterSize(z: number, lat = 0): number {
  if (z >= SHARED_ZOOM) {
    // Sized as at the equator, finer than a cell away from it, since plotters stretch
    // these past MAX_ZOOM. A power of two, so tiles past SHARED_ZOOM are cut from their
    // ancestor's surface.
    const fit = tileMetres(z, 0) / CELL_M;
    return Math.min(256, 2 ** Math.max(0, Math.round(Math.log2(fit))));
  }
  // At the tile's latitude, in steps, so neighbours north and south mostly share a size,
  // and with it a pixel grid. Where the size steps, every few degrees, their lines meet
  // about as closely as elsewhere: a few tenths of a pixel, and under one.
  const fit = tileMetres(z, lat) / CELL_M / RASTER_STEP;
  return Math.min(256, RASTER_STEP * Math.max(1, Math.round(fit)));
}

/** The least a raster reaches past its tile, in pixels: as far as it's traced. */
const HALO_MIN_PX = 8;

/** Tiles past this zoom are cut from their ancestor's surface at it: their pixels are
 * the same size, so the surface is built once for all of them, and they meet without a
 * seam. */
export const SHARED_ZOOM = 14;

// A tile's pixels are its ancestor's at SHARED_ZOOM, as `cut` takes them: so long as a
// cell's size keeps their rasters powers of two apart.
for (let z = SHARED_ZOOM + 1; z <= MAX_ZOOM; z++) {
  if (rasterSize(z) * 2 ** (z - SHARED_ZOOM) !== rasterSize(SHARED_ZOOM)) {
    throw new Error(`zoom ${z} tiles can't be cut from zoom ${SHARED_ZOOM}'s`);
  }
}

/** A tile's ancestor at SHARED_ZOOM, past it; else the tile itself. */
export function sharedTile(z: number, x: number, y: number) {
  const k = Math.max(0, z - SHARED_ZOOM);
  return { z: z - k, x: x >> k, y: y >> k, k };
}

/** The margin a tile reads beyond its edges, in metres: the interpolation's reach and
 * the blur's. */
export const MARGIN_M = RADIUS_M + 4 * BLUR_M;

/** S-4 B-412 depth labels, floored toward shoal, as the grid's `depths`. */
export function depthLabels(d: number) {
  const floor = (x: number) => Math.floor(x + 1e-9);
  const r =
    P.sounding_rounding.find(
      (t) => !("below_m" in t) || d < (t as { below_m: number }).below_m,
    ) ?? P.sounding_rounding[P.sounding_rounding.length - 1];
  return {
    depth_m: floor(d * r.per_m) / r.per_m,
    depth_ft: floor(d / P.m_per_ft),
    depth_fm: floor(d / P.m_per_fathom),
  };
}

/** Contour levels drawn at a zoom, as the grid's tiers. */
export function contourLevels(z: number): number[] {
  const tier = P.contour_tiers.find((t) => z < t.below_zoom);
  return (tier?.isobaths_m ?? P.isobaths_m).filter(
    (l) => l <= MAX_AREA_DEPTH_M,
  );
}

export interface Raster {
  n: number;
  halo: number;
  size: number;
  /** Metres per pixel. */
  pm: number;
  /** Surface depth, NaN where there's none. */
  depth: Float32Array;
  /** The share of each pixel's neighbourhood with a depth; the surface reaches as far
   * as a half. */
  cover: Float32Array;
  /** Within a cell of a sounded cell. */
  measured: Uint8Array;
  /** Metres to the nearest sounded cell, and the distance that counts as measured. */
  near: Float32Array;
  measuredM: number;
  /** Past the interpolated pixels, the shoalest of the interpolated surface and the
   * unconfirmed shoals in each pixel or beside it; Infinity where there's none, and over
   * the interpolated pixels. */
  shoalest: Float32Array;
  /** The same, of the unconfirmed shoals alone. */
  shoal: Float32Array;
  /** The depth before the margin where it's at or above 0 m, which decides where water
   * is wet: the margin never makes it drying. */
  wet: Float32Array;
}

interface Source {
  /** Position in raster pixels. */
  x: number;
  y: number;
  m: number;
  sigma: number;
}

/**
 * The surface over a tile and its margin: inverse distance to the 12 nearest cells
 * within 200 m, with at least one in each quadrant and 40 m added to every distance, as
 * `gdal_grid invdistnn`; a gaussian blur clamped so no pixel reads deeper than it was
 * interpolated; then k × σ off, with σ from the nearest cell widened by its distance.
 * Every depth the blur carries past the interpolated pixels is capped at the shoalest of
 * the interpolated surface and `shoals` in its pixel or beside it.
 */
export function surface(
  z: number,
  x: number,
  y: number,
  cells: Cell[],
  shoals: Shoal[] = [],
): Raster {
  const b = tileBounds(z, x, y);
  const lat = (b.north + b.south) / 2;
  const n = rasterSize(z, lat);
  const pm = tileMetres(z, lat) / n;
  // At least as far as a tile is traced past its edges, zoomed out where the margin is
  // less than a pixel or two.
  const halo = Math.max(Math.ceil(MARGIN_M / pm), HALO_MIN_PX);
  const size = n + 2 * halo;
  const at = (lon: number, la: number) => {
    const f = tileFraction(lon, la, z);
    return { x: (f.x - x) * n + halo, y: (f.y - y) * n + halo };
  };

  // One source per pixel: the shoalest cell in it.
  const byPixel = new Map<
    number,
    { cell: Cell; x: number; y: number; depth: number }
  >();
  for (const cell of cells) {
    const c = cellCenter(cell.py, cell.px);
    const p = at(c.lon, c.lat);
    if (p.x < 0 || p.y < 0 || p.x >= size || p.y >= size) continue;
    const i = Math.floor(p.y) * size + Math.floor(p.x);
    const depth = cellDepth(cell);
    const was = byPixel.get(i);
    if (!was || depth < was.depth) byPixel.set(i, { cell, ...p, depth });
  }
  const sources: Source[] = [...byPixel.values()].map((s) => ({
    x: s.x,
    y: s.y,
    m: s.cell.m,
    sigma: cellSigma(s.cell),
  }));

  // Zoomed out, a pixel is wider than the radius; it still sees every cell inside it.
  const searchM = Math.max(RADIUS_M, pm * Math.SQRT1_2);
  const reach = Math.ceil(searchM / pm);
  const measuredM = Math.max(CELL_M, pm);
  const median = new Float32Array(size * size).fill(NaN);
  const near = new Float32Array(size * size).fill(Infinity);
  const nearSigma = new Float32Array(size * size);
  // Only pixels within reach of a source are searched.
  const sourced = new Uint8Array(size * size);
  for (const s of sources)
    sourced[Math.floor(s.y) * size + Math.floor(s.x)] = 1;
  const candidates = dilate(sourced, size, reach);
  const search = nearestSearch(sources, size, pm, searchM, MAX_POINTS);
  const nearest = neighbours(MAX_POINTS);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      if (!candidates[i]) continue;
      search(px, py, nearest);
      const count = nearest.n;
      if (count === 0) continue;
      near[i] = Math.sqrt(nearest.d2[0]);
      nearSigma[i] = sources[nearest.j[0]].sigma;
      // Between tracks, the grid's rule: three cells or more, one in each quadrant. A
      // pixel the boat sounded keeps a depth whatever surrounds it, so its own track
      // draws as areas, not only soundings.
      if (near[i] > measuredM) {
        if (count < MIN_POINTS) continue;
        let quadrants = 0;
        for (let k = 0; k < count; k++) {
          quadrants |=
            1 << ((nearest.dx[k] >= 0 ? 1 : 0) + (nearest.dy[k] >= 0 ? 2 : 0));
        }
        if (quadrants !== 0b1111) continue;
      }
      let sw = 0;
      let swm = 0;
      for (let k = 0; k < count; k++) {
        const w = 1 / (nearest.d2[k] + SMOOTHING_M * SMOOTHING_M);
        sw += w;
        swm += w * sources[nearest.j[k]].m;
      }
      median[i] = swm / sw;
    }
  }

  const { values: blurred, cover } = blur(median, size, BLUR_M / pm);
  const depth = new Float32Array(size * size).fill(NaN);
  const measured = new Uint8Array(size * size);
  for (let i = 0; i < depth.length; i++) {
    if (near[i] <= measuredM) measured[i] = 1;
    const m = blurred[i];
    if (Number.isNaN(m) || !Number.isFinite(near[i])) continue;
    const sigma = Math.hypot(
      nearSigma[i],
      // Widened only past sounded water: zoomed out, a pixel's own cells can sit far
      // from its centre.
      SIGMA_PER_M * Math.max(0, near[i] - measuredM),
    );
    const d = m - K * sigma;
    depth[i] = m >= 0 ? Math.max(0, d) : d;
  }

  // Carried past the interpolated pixels, a depth is never deeper than the surface it's
  // carried from, in its pixel or beside it, or an unconfirmed shoal there. Not the
  // cells': the surface between them is already allowed deeper than its shoalest cell,
  // and an edge held to the cell would draw the difference as rings round it.
  const bySurface = depth.map((d, i) =>
    Number.isNaN(median[i]) || Number.isNaN(d) ? Infinity : d,
  );
  const byShoal = new Float32Array(size * size).fill(Infinity);
  for (const s of shoals) {
    const f = tileFraction(s.lon, s.lat, z);
    const sx = Math.floor((f.x - x) * n + halo);
    const sy = Math.floor((f.y - y) * n + halo);
    if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
    byShoal[sy * size + sx] = Math.min(byShoal[sy * size + sx], s.depth);
  }
  const shoalest = new Float32Array(size * size).fill(Infinity);
  const shoal = new Float32Array(size * size).fill(Infinity);
  // Beside neither, a pixel's caps stay Infinity.
  const capped = dilate(
    Uint8Array.from(bySurface, (d, i) =>
      d !== Infinity || byShoal[i] !== Infinity ? 1 : 0,
    ),
    size,
    1,
  );
  for (let py = 0; py < size; py++) {
    const y0 = Math.max(0, py - 1);
    const y1 = Math.min(size - 1, py + 1);
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      // The interpolated pixels follow their cells as the grid's do, capped by none.
      if (!Number.isNaN(median[i]) || !capped[i]) continue;
      let least = Infinity;
      let byShoals = Infinity;
      for (let yy = y0; yy <= y1; yy++) {
        for (
          let j = yy * size + Math.max(0, px - 1);
          j <= yy * size + Math.min(size - 1, px + 1);
          j++
        ) {
          least = Math.min(least, bySurface[j], byShoal[j]);
          byShoals = Math.min(byShoals, byShoal[j]);
        }
      }
      shoalest[i] = least;
      shoal[i] = byShoals;
      if (!Number.isNaN(depth[i])) depth[i] = Math.min(depth[i], least);
    }
  }
  const wet = depth.map((d, i) =>
    d < 0 || Number.isNaN(blurred[i]) ? d : Math.max(d, blurred[i]),
  );
  return {
    n,
    halo,
    size,
    pm,
    depth,
    cover,
    measured,
    near,
    measuredM,
    shoalest,
    shoal,
    wet,
  };
}

/** A pixel's nearest sources, nearest first, `n` of them: each one's index, its squared
 * distance and offset in metres, and the pixel it's in. */
export interface Neighbours {
  n: number;
  j: Int32Array;
  d2: Float64Array;
  dx: Float64Array;
  dy: Float64Array;
  b: Int32Array;
}

/** Room for `max` neighbours, which a search fills. */
export function neighbours(max: number): Neighbours {
  return {
    n: 0,
    j: new Int32Array(max),
    d2: new Float64Array(max),
    dx: new Float64Array(max),
    dy: new Float64Array(max),
    b: new Int32Array(max),
  };
}

/**
 * A search for the `max` nearest of `points`, at most one in each pixel of a raster
 * `size` a side, within `searchM` metres of a pixel's centre, `pm` metres a pixel. It
 * fills `out` in the order a full search sorts them: by distance, then by pixel, row by
 * row, so the sums and ties that follow come out the same.
 *
 * It visits the pixels within reach nearest first, by how close to the centre a point
 * in each can be, and stops at the first that can't hold one nearer than the `max`-th
 * found: dense water stops early; between tracks, the whole radius is still searched.
 */
export function nearestSearch(
  points: { x: number; y: number }[],
  size: number,
  pm: number,
  searchM: number,
  max: number,
): (px: number, py: number, out: Neighbours) => void {
  const bucket = new Int32Array(size * size).fill(-1);
  const xs = new Float64Array(points.length);
  const ys = new Float64Array(points.length);
  points.forEach((s, j) => {
    bucket[Math.floor(s.y) * size + Math.floor(s.x)] = j;
    xs[j] = s.x;
    ys[j] = s.y;
  });
  const reach = Math.ceil(searchM / pm);
  const r2 = searchM * searchM;
  // More than the rounding of a squared distance in metres, so no pixel that could hold
  // a nearer point is passed over.
  const EPS = 1e-6;
  const offsets: { ox: number; oy: number; d2: number }[] = [];
  for (let oy = -reach; oy <= reach; oy++) {
    for (let ox = -reach; ox <= reach; ox++) {
      // A point in a pixel `ox` across is at least |ox| - 0.5 pixels from the centre.
      const gx = Math.max(0, Math.abs(ox) - 0.5) * pm;
      const gy = Math.max(0, Math.abs(oy) - 0.5) * pm;
      const d2 = gx * gx + gy * gy;
      if (d2 - EPS <= r2) offsets.push({ ox, oy, d2 });
    }
  }
  offsets.sort((a, b) => a.d2 - b.d2);
  const count = offsets.length;
  const oxs = Int32Array.from(offsets, (o) => o.ox);
  const oys = Int32Array.from(offsets, (o) => o.oy);
  const od2 = Float64Array.from(offsets, (o) => o.d2);
  return (px, py, out) => {
    const cx = px + 0.5;
    const cy = py + 0.5;
    const { j: js, d2: d2s, dx: dxs, dy: dys, b: bs } = out;
    let n = 0;
    for (let o = 0; o < count; o++) {
      if (n === max && od2[o] - EPS > d2s[max - 1]) break;
      const by = py + oys[o];
      const bx = px + oxs[o];
      if (by < 0 || by >= size || bx < 0 || bx >= size) continue;
      const b = by * size + bx;
      const j = bucket[b];
      if (j < 0) continue;
      const dx = (xs[j] - cx) * pm;
      const dy = (ys[j] - cy) * pm;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      let k = n;
      while (
        k > 0 &&
        (d2s[k - 1] > d2 || (d2s[k - 1] === d2 && bs[k - 1] > b))
      ) {
        k--;
      }
      if (k >= max) continue;
      // Those after it move down one, the last falling off when the list is full.
      for (let q = n < max ? n : max - 1; q > k; q--) {
        js[q] = js[q - 1];
        d2s[q] = d2s[q - 1];
        dxs[q] = dxs[q - 1];
        dys[q] = dys[q - 1];
        bs[q] = bs[q - 1];
      }
      js[k] = j;
      d2s[k] = d2;
      dxs[k] = dx;
      dys[k] = dy;
      bs[k] = b;
      if (n < max) n++;
    }
    out.n = n;
  };
}

/** The pixels within `r` of one set in `mask`, across and down: a square about each. */
function dilate(mask: Uint8Array, size: number, r: number): Uint8Array {
  // Along each row, then each column, from the nearest set pixel either side.
  const along = (src: Uint8Array, step: number, stride: number) => {
    const out = new Uint8Array(src.length);
    for (let line = 0; line < size; line++) {
      const at = (p: number) => line * stride + p * step;
      let last = -Infinity;
      for (let p = 0; p < size; p++) {
        if (src[at(p)]) last = p;
        if (p - last <= r) out[at(p)] = 1;
      }
      last = Infinity;
      for (let p = size - 1; p >= 0; p--) {
        if (src[at(p)]) last = p;
        if (last - p <= r) out[at(p)] = 1;
      }
    }
    return out;
  };
  return along(along(mask, 1, size), size, 1);
}

/**
 * A gaussian blur of the valid pixels, never deeper than the pixel was, and the share of
 * each pixel's neighbourhood that's valid. The blurred depth reaches a pixel past the
 * valid ones, and the surface's edge is drawn where the share is a half, so it curves
 * as the depths do rather than following rows of pixels.
 */
function blur(
  values: Float32Array,
  size: number,
  sigma: number,
): { values: Float32Array; cover: Float32Array } {
  if (sigma < 0.5) {
    return {
      values,
      cover: values.map((v) => (Number.isNaN(v) ? 0 : 1)),
    };
  }
  const r = Math.ceil(3 * sigma);
  const kernel = Float64Array.from({ length: 2 * r + 1 }, (_, i) =>
    Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)),
  );
  // Each line's taps, past the raster's edge left out. A window none of whose weights
  // is set sums to 0, as it's left.
  const set = new Int32Array(size + 1);
  const pass = (src: Float32Array, wsrc: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length);
    const wout = new Float32Array(src.length);
    const step = horizontal ? 1 : size;
    const stride = horizontal ? size : 1;
    for (let line = 0; line < size; line++) {
      const first = line * stride;
      for (let p = 0; p < size; p++) {
        set[p + 1] = set[p] + (wsrc[first + p * step] !== 0 ? 1 : 0);
      }
      for (let p = 0; p < size; p++) {
        const lo = Math.max(-r, -p);
        const hi = Math.min(r, size - 1 - p);
        if (set[p + hi + 1] === set[p + lo]) continue;
        const i = first + p * step;
        let s = 0;
        let w = 0;
        for (let j = lo; j <= hi; j++) {
          s += kernel[j + r] * src[i + j * step];
          w += kernel[j + r] * wsrc[i + j * step];
        }
        out[i] = s;
        wout[i] = w;
      }
    }
    return [out, wout];
  };
  const valid = values.map((v) => (Number.isNaN(v) ? 0 : 1));
  const zeroed = values.map((v) => (Number.isNaN(v) ? 0 : v));
  const [h, wh] = pass(zeroed, valid, true);
  const [v, wv] = pass(h, wh, false);
  // The weight a window would have were every pixel valid, a row's in single precision
  // and then down its column, as the passes take it: wanted only where some is valid.
  const row = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    let w = 0;
    for (let j = Math.max(-r, -x); j <= Math.min(r, size - 1 - x); j++) {
      w += kernel[j + r];
    }
    row[x] = w;
  }
  const whole = (x: number, y: number) => {
    let w = 0;
    for (let j = Math.max(-r, -y); j <= Math.min(r, size - 1 - y); j++) {
      w += kernel[j + r] * row[x];
    }
    return Math.fround(w);
  };
  const cover = new Float32Array(values.length);
  for (let i = 0; i < cover.length; i++) {
    if (wv[i] !== 0) cover[i] = wv[i] / whole(i % size, Math.floor(i / size));
  }
  return {
    values: values.map((d, i) =>
      wv[i] <= 0
        ? NaN
        : Number.isNaN(d)
          ? v[i] / wv[i]
          : Math.min(v[i] / wv[i], d),
    ),
    cover,
  };
}

/** The S-57 layers of one tile: DEPARE, DEPCNT, SOUNDG and M_QUAL. */
export function buildTile(
  z: number,
  x: number,
  y: number,
  cells: Cell[],
  shoals: Shoal[],
  detail: Detail = "high",
  shared?: Map<string, Prepared>,
): Buffer | undefined {
  if (cells.length === 0 && shoals.length === 0) return undefined;
  // Cut from the ancestor's surface past SHARED_ZOOM, which `cells` and `shoals` cover,
  // kept for its other tiles. Zoomed out, a tile shares its surface with none.
  const a = sharedTile(z, x, y);
  const key = `${a.z}/${a.x}/${a.y}`;
  // A tile at SHARED_ZOOM uses its surface when it's kept, but only a tile cut from it
  // keeps it, so a view at SHARED_ZOOM doesn't push the others out.
  const kept = z >= SHARED_ZOOM ? shared?.get(key) : undefined;
  const prepared = kept ?? prepare(surface(a.z, a.x, a.y, cells, shoals));
  if (kept || z > SHARED_ZOOM) {
    // The most recently used, kept longest.
    shared?.delete(key);
    shared?.set(key, prepared);
  }
  // The surface's pixels, as `surface` sized them.
  const ab = tileBounds(a.z, a.x, a.y);
  const n = rasterSize(a.z, (ab.north + ab.south) / 2) / 2 ** a.k;
  const t = cut(prepared, (x - (a.x << a.k)) * n, (y - (a.y << a.k)) * n, n);
  const fine = detail === "high" && z >= FINE_ZOOM;
  const tolerance = z >= MAX_ZOOM ? SIMPLIFY_MAX_ZOOM_UNITS : SIMPLIFY_UNITS;
  const areaTolerance = Math.max(1, tolerance * AREA_SHARE);
  let shoalest = Infinity;
  let deepest = -Infinity;
  t.extent.forEach((e, i) => {
    if (e < 0) return;
    shoalest = Math.min(shoalest, t.depth[i], t.wet[i]);
    deepest = Math.max(deepest, t.depth[i], t.wet[i]);
  });
  const DEPARE: Feature[] = [];
  const edges = fine ? FINE_EDGES : [DRYING_FLOOR_M, ...LEVELS];
  for (let k = 0; k < edges.length - 1; k++) {
    const [lo, hi] = [edges[k], edges[k + 1]];
    // Each edge a few millimetres shoaler than the band's: water at exactly a band's
    // depth, as water capped at a shoal's, is inside it, not on its edge.
    if (hi - EDGE_M <= shoalest || lo - EDGE_M > deepest) continue;
    const polys = polygons(t, band(t, lo - EDGE_M, hi - EDGE_M), areaTolerance);
    if (polys.length) {
      DEPARE.push({
        type: "Polygon",
        polygons: polys,
        properties: { DRVAL1: lo, DRVAL2: hi },
      });
    }
  }

  const DEPCNT: Feature[] = [];
  const levels: Level[] = fine
    ? FINE_CONTOURS
    : contourLevels(z).map((m) => ({ m }));
  const traced = isolines(
    t,
    levels.filter((l) => l.m >= shoalest && l.m <= deepest).map((l) => l.m),
    tolerance,
  );
  for (const level of levels) {
    const lines = traced.get(level.m) ?? [];
    if (lines.length) {
      DEPCNT.push({
        type: "LineString",
        lines,
        properties: {
          VALDCO: level.m,
          QUAPOS: 4,
          ...(level.unit ? { unit: level.unit } : {}),
          ...(level.major ? { major: 1 } : {}),
        },
      });
    }
  }

  // The shoalest sounding in each lattice cell: a cell's depth at its centre, or an
  // unconfirmed shoal at its own position.
  const lattice = new Map<
    number,
    { p: Point; d: number; unconfirmed: boolean }
  >();
  const place = (lon: number, lat: number, d: number, unconfirmed: boolean) => {
    const f = tileFraction(lon, lat, z);
    const fx = f.x - x;
    const fy = f.y - y;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return;
    const i =
      Math.floor(fy * SOUNDINGS_PER_SIDE) * SOUNDINGS_PER_SIDE +
      Math.floor(fx * SOUNDINGS_PER_SIDE);
    const was = lattice.get(i);
    if (!was || d < was.d) {
      lattice.set(i, {
        p: [Math.round(fx * EXTENT), Math.round(fy * EXTENT)],
        d,
        unconfirmed,
      });
    }
  };
  let first = Infinity;
  let last = -Infinity;
  let tvu = 0;
  let passes = 0;
  // Over the tile's own margin too, whose cells its surface is drawn from: not the rest of
  // an ancestor's that `cells` may hold.
  const bounds = tileBounds(z, x, y);
  const dLat = MARGIN_M / M_PER_DEG_LAT;
  const dLon =
    MARGIN_M /
    mPerDegLon(
      Math.min(Math.max(Math.abs(bounds.north), Math.abs(bounds.south)), 85),
    );
  const own = cells.filter((c) => {
    const p = cellCenter(c.py, c.px);
    return (
      p.lat >= bounds.south - dLat &&
      p.lat <= bounds.north + dLat &&
      p.lon >= bounds.west - dLon &&
      p.lon <= bounds.east + dLon
    );
  });
  const tided =
    own.length > 0 && own.every((c) => c.t !== undefined && !c.untidedBelow);
  for (const cell of cells) {
    const c = cellCenter(cell.py, cell.px);
    const f = tileFraction(c.lon, c.lat, z);
    if (f.x < x || f.y < y || f.x >= x + 1 || f.y >= y + 1) continue;
    const d = cellDepth(cell);
    place(c.lon, c.lat, d, false);
    first = Math.min(first, cell.first);
    last = Math.max(last, cell.last);
    tvu = Math.max(tvu, 2 + 0.05 * Math.max(d, 0), 1.96 * cellSigma(cell));
    passes += cell.passes;
  }
  for (const s of shoals) place(s.lon, s.lat, s.depth, true);
  const SOUNDG: Feature[] = [...lattice.values()].map(
    ({ p, d, unconfirmed }) => ({
      type: "Point",
      points: [p],
      properties: {
        ...depthLabels(d),
        VALSOU: Math.floor(d * 100 + 1e-9) / 100,
        QUASOU: unconfirmed ? 9 : 8,
        QUAPOS: unconfirmed ? 8 : 7,
        TECSOU,
        ...(unconfirmed ? { unconfirmed: 1 } : {}),
      },
    }),
  );

  const date = (day: number) =>
    new Date(day * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
  const quality = {
    CATZOC: 5,
    POSACC: POSACC_M,
    SOUACC: Math.ceil(tvu * 10) / 10,
    TECSOU,
    // Passes, not soundings: the plugin keeps a cell's passes, not its soundings.
    passes,
    // ponytail: one flag per tile, untided if any of its cells is. Station reach and
    // signalk-tides' absence both cover whole stretches of water, so a tile seldom mixes;
    // split the coverage by it if one does too often.
    tided: tided ? 1 : 0,
    INFORM: tided ? INFORM.tided : INFORM.untided,
    ...(Number.isFinite(first)
      ? { SURSTA: date(first), SUREND: date(last) }
      : {}),
  };
  const M_QUAL: Feature[] = [];
  // Measured water and interpolated, split along one edge, so they neither overlap nor
  // leave a gap.
  const measured = polygons(
    t,
    t.extent.map((e, i) => Math.min(e, t.measured[i])),
    tolerance,
  );
  if (measured.length) {
    M_QUAL.push({
      type: "Polygon",
      polygons: measured,
      properties: { ...quality, kind: "measured" },
    });
  }
  const between = polygons(
    t,
    t.extent.map((e, i) => Math.min(e, -t.measured[i])),
    tolerance,
  );
  if (between.length) {
    M_QUAL.push({
      type: "Polygon",
      polygons: between,
      properties: { ...quality, kind: "interpolated" },
    });
  }

  if (!DEPARE.length && !SOUNDG.length && !M_QUAL.length) return undefined;
  return encodeTile({ DEPARE, DEPCNT, SOUNDG, M_QUAL });
}
