// One chart tile of the live layer, built from the cells under it: the grid's depth
// surface (packages/grid/src/grid/surface.py, docs/plans/global-grid/surface.md) and its
// S-57 overlay layers (overlay.py), for one vessel.
//
// The grid works on its 2/3″ pixels per 1° tile. A chart tile here is a square raster in
// Web Mercator of at most 256 pixels a side, none finer than a cell, so at the cells'
// zoom a pixel is about a cell; zoomed out, a pixel holds the shoalest of its cells, as
// the grid aggregates. Distances are in metres, so the radius, smoothing and blur mean
// what they mean in the grid at every zoom.
import { contours } from "d3-contour";
import { Cell, Shoal, cellDepth, cellSigma } from "./cells.js";
import {
  DEFINITIONS,
  M_PER_DEG_LAT,
  cellCenter,
  tileBounds,
  tileFraction,
  tileMetres,
} from "./geometry.js";
import { EXTENT, Feature, Point, encodeTile } from "./mvt.js";

const {
  interpolation_radius_m: RADIUS_M,
  smoothing_m: SMOOTHING_M,
  blur_px,
} = DEFINITIONS.surface;
const { k: K, sigma_per_m: SIGMA_PER_M } = DEFINITIONS.statistic;
const P = DEFINITIONS.portrayal;
const { max_gap_px: MAX_GAP_PX, notch_px: NOTCH_PX, fill_px: FILL_PX } = P;
// `close` fills gaps of up to MAX_GAP_PX only while they're smaller than its square.
if (NOTCH_PX % 2 || (NOTCH_PX + 1) ** 2 <= MAX_GAP_PX) {
  throw new Error(
    "portrayal.notch_px must be even, and close every max_gap_px gap",
  );
}

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
/** Keeps a band's upper edge out of it, a millimetre: too little to see. */
const BAND_EPS_M = 0.001;
/** Soundings per tile side, as the grid's lattice. */
const SOUNDINGS_PER_SIDE = 8;
/** The finest zoom built; clients overzoom past it, as the grid's overlay. */
export const MAX_ZOOM = 15;
export const MIN_ZOOM = 4;
const LEVELS = P.isobaths_m.filter((l) => l <= MAX_AREA_DEPTH_M);
const POSACC_M = 10;
const TECSOU = 1;
const INFORM = {
  tided:
    "This boat's own soundings, recorded by its Crowd Depth plugin. Reduced to chart datum with predicted tides, and not calibrated. Not for navigation.",
  untided:
    "This boat's own soundings, recorded by its Crowd Depth plugin. Not reduced for tide or to chart datum, and not calibrated. Not for navigation.",
};

/** Raster pixels a side for a tile: at most 256, and none smaller than a cell. */
export function rasterSize(z: number, _lat?: number): number {
  // Sized by zoom alone, as at the equator, so neighbouring tiles share a pixel grid and
  // their areas meet without a seam. Away from it pixels are finer than a cell.
  return Math.max(1, Math.min(256, Math.round(tileMetres(z, 0) / CELL_M)));
}

/** The interpolation's reach past a tile's edges, in metres, and the blur's. */
export const MARGIN_M = RADIUS_M + 4 * BLUR_M;
/** Pixels the surface reaches past that: a pixel grown, one closed, FILL_PX carried, and
 * the edge's blur. */
const REACH_PX = 2 + FILL_PX + 3;

/** The margin a tile at zoom `z` reads beyond its edges, in metres: MARGIN_M, and
 * REACH_PX of its pixels, which zoomed out are wider than MARGIN_M. */
export function marginM(z: number): number {
  return MARGIN_M + (REACH_PX * tileMetres(z, 0)) / rasterSize(z);
}

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

interface Raster {
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
  /** At least 0 where the surface is drawn, from `outline`: where half the
   * neighbourhood has a depth or within a cell of a sounded cell. Scaled so it decides
   * the edge, and the depth the bands within it. */
  edge: Float32Array;
  /** As `edge`, for the part of it within a cell of a sounded cell, which is measured;
   * the rest is interpolated. */
  measuredEdge: Float32Array;
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
 * Its edge is grown a pixel all round and over small gaps and notches, and
 * every depth past the interpolated pixels is capped at the shoalest of `cells` and
 * `shoals` in its pixel or beside it.
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
  const halo = Math.ceil(marginM(z) / pm);
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

  // The source in each pixel, for the search.
  const bucket = new Int32Array(size * size).fill(-1);
  sources.forEach((s, j) => {
    bucket[Math.floor(s.y) * size + Math.floor(s.x)] = j;
  });

  // Zoomed out, a pixel is wider than the radius; it still sees every cell inside it.
  const searchM = Math.max(RADIUS_M, pm * Math.SQRT1_2);
  const reach = Math.ceil(searchM / pm);
  const measuredM = Math.max(CELL_M, pm);
  const median = new Float32Array(size * size).fill(NaN);
  const near = new Float32Array(size * size).fill(Infinity);
  const nearSigma = new Float32Array(size * size);
  const candidates = new Uint8Array(size * size);
  for (const s of sources) {
    for (let dy = -reach; dy <= reach; dy++) {
      const yy = Math.floor(s.y) + dy;
      if (yy < 0 || yy >= size) continue;
      for (let dx = -reach; dx <= reach; dx++) {
        const xx = Math.floor(s.x) + dx;
        if (xx >= 0 && xx < size) candidates[yy * size + xx] = 1;
      }
    }
  }
  const found: { s: Source; d2: number; dx: number; dy: number }[] = [];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      if (!candidates[i]) continue;
      const cx = px + 0.5;
      const cy = py + 0.5;
      found.length = 0;
      for (let by = py - reach; by <= py + reach; by++) {
        if (by < 0 || by >= size) continue;
        for (let bx = px - reach; bx <= px + reach; bx++) {
          if (bx < 0 || bx >= size) continue;
          const j = bucket[by * size + bx];
          if (j < 0) continue;
          const s = sources[j];
          const dx = (s.x - cx) * pm;
          const dy = (s.y - cy) * pm;
          const d2 = dx * dx + dy * dy;
          if (d2 <= searchM * searchM) found.push({ s, d2, dx, dy });
        }
      }
      if (found.length === 0) continue;
      found.sort((a, b) => a.d2 - b.d2);
      const nearest = found.slice(0, MAX_POINTS);
      near[i] = Math.sqrt(nearest[0].d2);
      nearSigma[i] = nearest[0].s.sigma;
      // Between tracks, the grid's rule: three cells or more, one in each quadrant. A
      // pixel the boat sounded keeps a depth whatever surrounds it, so its own track
      // draws as areas, not only soundings.
      if (near[i] > measuredM) {
        if (nearest.length < MIN_POINTS) continue;
        let quadrants = 0;
        for (const f of nearest) {
          quadrants |= 1 << ((f.dx >= 0 ? 1 : 0) + (f.dy >= 0 ? 2 : 0));
        }
        if (quadrants !== 0b1111) continue;
      }
      let sw = 0;
      let swm = 0;
      for (const f of nearest) {
        const w = 1 / (f.d2 + SMOOTHING_M * SMOOTHING_M);
        sw += w;
        swm += w * f.s.m;
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
  // The surface is drawn where half of each pixel's blurred neighbourhood has a depth or
  // within a cell of a sounded cell, and its measured part within a cell of one. Each is
  // traced from a mask, as the grid's edges are, smoothed so it curves rather than
  // following pixels or the round reach of each cell.
  const notches = tileMetres(z, 0) / n <= 1.5 * CELL_M;
  const sounded = near.map((d) => (d <= measuredM ? 1 : 0));
  const interpolated = cover.map((c, i) => (c >= 0.5 && !sounded[i] ? 1 : 0));
  const drawn = shape(
    sounded.map((v, i) => v || interpolated[i]),
    size,
    notches,
  );
  const edge = soften(drawn, size);
  // What's drawn within a pixel of sounded water, but never over interpolated water: its
  // outer edge is the surface's.
  const near1 = square(sounded, size, 1, true);
  const measuredEdge = soften(
    drawn.map((v, i) => (v && near1[i] && !interpolated[i] ? 1 : 0)),
    size,
  );
  fill(drawn, depth, size);

  // Carried past the interpolated pixels, a depth is never deeper than a published
  // sounding in its pixel or beside it, cell or unconfirmed shoal, as the grid
  // overlay's carried depths.
  const cap = new Float32Array(size * size).fill(Infinity);
  for (const [i, s] of byPixel) cap[i] = Math.min(cap[i], s.depth);
  for (const s of shoals) {
    const f = tileFraction(s.lon, s.lat, z);
    const sx = Math.floor((f.x - x) * n + halo);
    const sy = Math.floor((f.y - y) * n + halo);
    if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
    cap[sy * size + sx] = Math.min(cap[sy * size + sx], s.depth);
  }
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      if (!Number.isNaN(median[i]) || Number.isNaN(depth[i])) continue;
      for (
        let yy = Math.max(0, py - 1);
        yy <= Math.min(size - 1, py + 1);
        yy++
      ) {
        for (
          let xx = Math.max(0, px - 1);
          xx <= Math.min(size - 1, px + 1);
          xx++
        ) {
          depth[i] = Math.min(depth[i], cap[yy * size + xx]);
        }
      }
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
    edge,
    measuredEdge,
    wet,
  };
}

/** Whether any, or all, of the square of side 2r + 1 about each pixel is in `mask`. Past
 * the raster's edge counts as in it for all, so an erosion doesn't eat in from there. */
function square(mask: Float32Array, size: number, r: number, any: boolean) {
  // A square is a row of r either side, then a column: two passes.
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length);
    const step = horizontal ? 1 : size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = horizontal ? x : y;
        const i = y * size + x;
        let v = any ? 0 : 1;
        for (let j = -r; j <= r; j++) {
          const inside = at + j >= 0 && at + j < size;
          const m = inside ? src[i + j * step] === 1 : !any;
          if (m === any) {
            v = any ? 1 : 0;
            break;
          }
        }
        out[i] = v;
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/** The edge of `mask`, as `shape` and `soften` draw it. */
export function outline(mask: Float32Array, size: number, notches: boolean) {
  return soften(shape(mask, size, notches), size);
}

/**
 * `mask` grown a pixel all round, as the grid's surface is, so a lone pass a pixel wide
 * survives the tracing at every zoom; and if `notches`, closed over gaps of up to
 * MAX_GAP_PX pixels and notches up to NOTCH_PX wide, which would trace as holes and
 * sharp V's, as the grid's `outline` does.
 */
function shape(mask: Float32Array, size: number, notches: boolean) {
  const grown = square(mask, size, 1, true);
  if (!notches) return grown;
  // A close by a square NOTCH_PX + 1 wide. It fills every gap of fewer than
  // (NOTCH_PX + 1)² pixels too, so all those of MAX_GAP_PX: an undrawn pixel it leaves
  // has a whole square of undrawn pixels about it.
  const r = NOTCH_PX / 2;
  return square(square(grown, size, r, true), size, r, false);
}

/**
 * The edge of `mask`, at least 0 inside, for tracing: blurred a pixel, so it curves, and
 * falls where the mask's does along a straight edge. About the distance to the edge in
 * pixels: a straight edge blurred by a gaussian of a pixel crosses each share at its
 * quantile, which its log-odds over 1.7 is close to.
 */
function soften(mask: Float32Array, size: number) {
  const g = gaussian(1, size);
  const cover = convolve(convolve(mask, size, g, true), size, g, false);
  return cover.map((w, i) => {
    const c = w / (g.inside[i % size] * g.inside[Math.floor(i / size)]);
    const p = Math.min(Math.max(c, 1e-9), 1 - 1e-9);
    return Math.log(p / (1 - p)) / 1.7;
  });
}

/** Give each pixel of `drawn` without a depth the nearest within FILL_PX, the shoaler of
 * two as near: where the surface is grown or closed past the depths blurred to it. Not
 * where only its edge's blur reaches, which zoomed out would join water kilometres
 * apart. */
function fill(drawn: Float32Array, depth: Float32Array, size: number) {
  const carried = depth.slice();
  for (let i = 0; i < drawn.length; i++) {
    if (!drawn[i] || !Number.isNaN(depth[i])) continue;
    const py = Math.floor(i / size);
    const px = i % size;
    let best = Infinity;
    for (let yy = py - FILL_PX; yy <= py + FILL_PX; yy++) {
      for (let xx = px - FILL_PX; xx <= px + FILL_PX; xx++) {
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const d2 = (xx - px) ** 2 + (yy - py) ** 2;
        const d = carried[yy * size + xx];
        if (
          d2 <= FILL_PX * FILL_PX &&
          !Number.isNaN(d) &&
          (d2 < best || (d2 === best && d < depth[i]))
        ) {
          best = d2;
          depth[i] = d;
        }
      }
    }
  }
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
  const g = gaussian(sigma, size);
  const valid = values.map((v) => (Number.isNaN(v) ? 0 : 1));
  const zeroed = values.map((v) => (Number.isNaN(v) ? 0 : v));
  const v = convolve(convolve(zeroed, size, g, true), size, g, false);
  const wv = convolve(convolve(valid, size, g, true), size, g, false);
  return {
    values: values.map((d, i) =>
      wv[i] <= 0
        ? NaN
        : Number.isNaN(d)
          ? v[i] / wv[i]
          : Math.min(v[i] / wv[i], d),
    ),
    // The share of the window inside the raster, a row's times a column's.
    cover: wv.map(
      (w, i) => w / (g.inside[i % size] * g.inside[Math.floor(i / size)]),
    ),
  };
}

/** A gaussian kernel of `sigma` pixels, and how much of it falls inside a raster of
 * `size` from each pixel of a row. */
function gaussian(sigma: number, size: number) {
  const r = Math.ceil(3 * sigma);
  const kernel = new Float32Array(2 * r + 1).map((_, i) =>
    Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)),
  );
  const inside = new Float32Array(size).map((_, x) => {
    let w = 0;
    for (let j = -r; j <= r; j++)
      if (x + j >= 0 && x + j < size) w += kernel[j + r];
    return w;
  });
  return { r, kernel, inside };
}

/** `src` convolved with a kernel along rows, or columns; zero past the raster's edge. */
function convolve(
  src: Float32Array,
  size: number,
  { r, kernel }: { r: number; kernel: Float32Array },
  horizontal: boolean,
): Float32Array {
  const out = new Float32Array(src.length);
  const step = horizontal ? 1 : size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = horizontal ? x : y;
      const lo = Math.max(-r, -at);
      const hi = Math.min(r, size - 1 - at);
      const i = y * size + x;
      let s = 0;
      for (let j = lo; j <= hi; j++) s += kernel[j + r] * src[i + j * step];
      out[i] = s;
    }
  }
  return out;
}

/** Polygons where `field` is at least 0 over the tile's own pixels, in tile
 * coordinates. The field is interpolated linearly between pixel centres, so edges follow
 * the depths rather than the pixels; NaN is outside. */
function polygons(r: Raster, field: (i: number) => number): Point[][][] {
  const { n, halo, size } = r;
  // Traced a few pixels past the tile's edges, which the renderer clips, so an edge
  // that falls between this tile's pixels and the next tile's is drawn where the
  // depths put it, not along the tile's edge.
  const b = Math.min(BUFFER_PX, halo);
  const m = n + 2 * b;
  const values = new Array<number>(m * m);
  let any = false;
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const v = field((y + halo - b) * size + x + halo - b);
      values[y * m + x] = v;
      if (v >= 0) any = true;
    }
  }
  if (!any) return [];
  const scale = EXTENT / n;
  const [shape] = contours().size([m, m]).thresholds([0])(values);
  return shape.coordinates.map((poly) =>
    poly.map((ring) =>
      smooth(ring.slice(0, -1) as Point[], true, m).map(
        ([x, y]) =>
          [Math.round((x - b) * scale), Math.round((y - b) * scale)] as Point,
      ),
    ),
  );
}

/** Pixels past each edge a tile's areas and contours are traced over, drawn in the
 * tile's buffer. */
const BUFFER_PX = 3;

/** Points on the edge of the traced grid, in the tile's buffer, which smoothing leaves
 * where they are. */
const onEdge = ([x, y]: Point, n: number) =>
  x <= 0 || y <= 0 || x >= n || y >= n;

/**
 * Round off the corners a raster of 20 m cells leaves: two passes of Chaikin's corner
 * cutting, each replacing a corner with points a quarter of the way along its two sides.
 * It cuts the same way whichever way a line runs, so two bands' shared edge stays shared.
 * Points on the tile's edge stay put.
 */
function smooth(points: Point[], closed: boolean, n = Infinity): Point[] {
  let pts = points;
  for (let pass = 0; pass < 2 && pts.length > 2; pass++) {
    const out: Point[] = [];
    const count = closed ? pts.length : pts.length - 1;
    if (!closed) out.push(pts[0]);
    for (let i = 0; i < count; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (onEdge(a, n) && onEdge(b, n)) {
        out.push(a, b);
        continue;
      }
      out.push(
        onEdge(a, n)
          ? a
          : [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]],
        onEdge(b, n)
          ? b
          : [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]],
      );
    }
    if (!closed) out.push(pts[pts.length - 1]);
    pts = out;
  }
  return closed ? [...pts, pts[0]] : pts;
}

/** The isoline at `level` between pixels that all have a depth, as lines in tile
 * coordinates. Marching squares interpolating `from`, about how far a pixel is past the
 * level in pixels, linearly between pixel centres, as the bands' edges are, so a contour lies
 * on the edge its bands share. */
function isoline(r: Raster, level: number, from: Float32Array): Point[][] {
  const { n, halo, size, depth, edge } = r;
  const at = (x: number, y: number) => (y + halo) * size + x + halo;
  const v = (x: number, y: number) => from[at(x, y)];
  const scale = EXTENT / n;
  const segments: [Point, Point][] = [];
  // Pixel centres sit at +0.5; a crossing is where the depth between two reaches level.
  const mid = (ax: number, ay: number, bx: number, by: number): Point => {
    const t = v(ax, ay) / (v(ax, ay) - v(bx, by));
    return [
      Math.round((ax + (bx - ax) * t + 0.5) * scale),
      Math.round((ay + (by - ay) * t + 0.5) * scale),
    ];
  };
  const b = Math.min(BUFFER_PX, halo - 1);
  for (let y = -1 - b; y < n + b; y++) {
    for (let x = -1 - b; x < n + b; x++) {
      const i = at(x, y);
      const corners = [i, i + 1, i + size + 1, i + size];
      let code = 0;
      corners.forEach((j, k) => (code |= (from[j] >= 0 ? 1 : 0) << k));
      if (code === 0 || code === 15) continue;
      if (corners.some((j) => Number.isNaN(depth[j]) || !(edge[j] >= 0))) {
        continue;
      }
      const top = mid(x, y, x + 1, y);
      const right = mid(x + 1, y, x + 1, y + 1);
      const bottom = mid(x, y + 1, x + 1, y + 1);
      const left = mid(x, y, x, y + 1);
      const cases: Record<number, [Point, Point][]> = {
        1: [[left, top]],
        2: [[top, right]],
        3: [[left, right]],
        4: [[right, bottom]],
        5: [
          [left, top],
          [right, bottom],
        ],
        6: [[top, bottom]],
        7: [[left, bottom]],
        8: [[bottom, left]],
        9: [[bottom, top]],
        10: [
          [top, right],
          [bottom, left],
        ],
        11: [[bottom, right]],
        12: [[right, left]],
        13: [[right, top]],
        14: [[top, left]],
      };
      segments.push(...cases[code]);
    }
  }
  return join(segments).map((line) =>
    smooth(line, false, EXTENT).map(
      ([x, y]) => [Math.round(x), Math.round(y)] as Point,
    ),
  );
}

/** Join segments that share ends into lines. */
function join(segments: [Point, Point][]): Point[][] {
  const id = (p: Point) => `${p[0]},${p[1]}`;
  const byStart = new Map<string, number[]>();
  segments.forEach(
    ([a], i) => byStart.get(id(a))?.push(i) ?? byStart.set(id(a), [i]),
  );
  const used = new Uint8Array(segments.length);
  const lines: Point[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [...segments[i]];
    for (;;) {
      const next = byStart
        .get(id(line[line.length - 1]))
        ?.find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      line.push(segments[next][1]);
    }
    lines.push(line);
  }
  return lines;
}

/** The S-57 layers of one tile: DEPARE, DEPCNT, SOUNDG and M_QUAL. */
export function buildTile(
  z: number,
  x: number,
  y: number,
  cells: Cell[],
  shoals: Shoal[],
): Buffer | undefined {
  if (cells.length === 0 && shoals.length === 0) return undefined;
  const r = surface(z, x, y, cells, shoals);
  const { depth, edge } = r;
  const has = (i: number) =>
    !Number.isNaN(depth[i]) && depth[i] <= MAX_AREA_DEPTH_M;
  // Just outside the surface, how far outside, so an edge falls between pixels rather
  // than on the last one with a depth, and a lone pixel draws as more than a point.
  const outside = (i: number) => Math.min(edge[i], -BAND_EPS_M);
  // Each edge is traced from about its distance in pixels, a depth's from a level as how
  // far the depth is from it over how fast it changes there, so where two meet, as a
  // band's and the surface's, the lesser is where both are.
  const size = r.size;
  // A change along a row or column: centred where both neighbours have a value, else to
  // whichever does.
  const slope = (
    v: Float32Array,
    i: number,
    step: number,
    a: boolean,
    b: boolean,
  ) => {
    const prev = a ? v[i - step] : NaN;
    const next = b ? v[i + step] : NaN;
    if (!Number.isNaN(prev) && !Number.isNaN(next)) return (next - prev) / 2;
    if (!Number.isNaN(next)) return next - v[i];
    if (!Number.isNaN(prev)) return v[i] - prev;
    return 0;
  };
  const gradient = (v: Float32Array) => {
    const g = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const px = i % size;
      const dx = slope(v, i, 1, px > 0, px < size - 1);
      const dy = slope(v, i, size, i >= size, i < v.length - size);
      // A floor, so flat water is far from every level.
      g[i] = Math.max(Math.hypot(dx, dy), 0.01);
    }
    return g;
  };
  const gDepth = gradient(depth);
  const gWet = gradient(r.wet);
  // Each level's field once, for its bands and its contour.
  const fields = new Map<number, Float32Array>();
  const field = (level: number) => {
    let f = fields.get(level);
    if (!f) {
      f =
        level === 0
          ? r.wet.map((w, i) => w / gWet[i])
          : depth.map((d, i) => (d - level) / gDepth[i]);
      fields.set(level, f);
    }
    return f;
  };

  const DEPARE: Feature[] = [];
  const bands: [number, number][] = [
    [DRYING_FLOOR_M, 0],
    ...LEVELS.slice(0, -1).map(
      (lo, i) => [lo, LEVELS[i + 1]] as [number, number],
    ),
  ];
  // Bands and contours past the tile's depths are empty: none is traced.
  let shoalest = Infinity;
  let deepest = -Infinity;
  depth.forEach((d, i) => {
    if (!has(i)) return;
    shoalest = Math.min(shoalest, d, r.wet[i]);
    deepest = Math.max(deepest, d, r.wet[i]);
  });
  for (const [lo, hi] of bands) {
    if (hi <= shoalest || lo > deepest) continue;
    const below = field(lo);
    const above = field(hi);
    // At least 0 inside the band, crossing 0 where the depth reaches either edge.
    const polys = polygons(r, (i) =>
      // A band holds its lower edge, not its upper: a depth of exactly 0 m, which the
      // margin clamps shallow water to, is wet, not drying.
      has(i) ? Math.min(below[i], -above[i] - BAND_EPS_M, edge[i]) : outside(i),
    );
    if (polys.length) {
      DEPARE.push({
        type: "Polygon",
        polygons: polys,
        properties: { DRVAL1: lo, DRVAL2: hi },
      });
    }
  }

  const DEPCNT: Feature[] = [];
  for (const level of contourLevels(z)) {
    if (level < shoalest || level > deepest) continue;
    const lines = isoline(r, level, field(level));
    if (lines.length) {
      DEPCNT.push({
        type: "LineString",
        lines,
        properties: { VALDCO: level, QUAPOS: 4 },
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
  // Over the margin too, whose cells the surface here is drawn from.
  const tided =
    cells.length > 0 &&
    cells.every((c) => c.t !== undefined && !c.untidedBelow);
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
  // Coverage is split along the measured part's edge: the two share it, so they neither
  // overlap nor leave a gap, and their outer edge is the surface's, so they reach as
  // far as its areas do.
  // Within a pixel of the surface's edge, its edge, signed by the part a pixel is in;
  // further in, the measured part's own edge.
  const split = (i: number) =>
    edge[i] < 1
      ? r.measuredEdge[i] >= 0
        ? edge[i]
        : -edge[i]
      : r.measuredEdge[i];
  const measured = polygons(r, (i) => (edge[i] < 0 ? edge[i] : split(i)));
  if (measured.length) {
    M_QUAL.push({
      type: "Polygon",
      polygons: measured,
      properties: { ...quality, kind: "measured" },
    });
  }
  const between = polygons(r, (i) =>
    has(i) ? (edge[i] < 0 ? edge[i] : -split(i)) : outside(i),
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
