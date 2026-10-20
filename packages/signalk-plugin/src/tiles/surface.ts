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
const INFORM =
  "This boat's own soundings, recorded by its Crowd Depth plugin. Not reduced for tide or to chart datum, and not calibrated. Not for navigation.";

/** Raster pixels a side for a tile: at most 256, and none smaller than a cell. */
export function rasterSize(z: number, _lat?: number): number {
  // Sized by zoom alone, as at the equator, so neighbouring tiles share a pixel grid and
  // their areas meet without a seam. Away from it pixels are finer than a cell.
  return Math.max(1, Math.min(256, Math.round(tileMetres(z, 0) / CELL_M)));
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
 */
export function surface(
  z: number,
  x: number,
  y: number,
  cells: Cell[],
): Raster {
  const b = tileBounds(z, x, y);
  const lat = (b.north + b.south) / 2;
  const n = rasterSize(z, lat);
  const pm = tileMetres(z, lat) / n;
  const halo = Math.ceil(MARGIN_M / pm);
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
  return { n, halo, size, pm, depth, cover, measured, near, measuredM };
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
  const kernel = Array.from({ length: 2 * r + 1 }, (_, i) =>
    Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)),
  );
  const pass = (src: Float32Array, wsrc: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length);
    const wout = new Float32Array(src.length);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        let w = 0;
        for (let j = -r; j <= r; j++) {
          const xx = horizontal ? x + j : x;
          const yy = horizontal ? y : y + j;
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
          const i = yy * size + xx;
          s += kernel[j + r] * src[i];
          w += kernel[j + r] * wsrc[i];
        }
        out[y * size + x] = s;
        wout[y * size + x] = w;
      }
    }
    return [out, wout];
  };
  const valid = values.map((v) => (Number.isNaN(v) ? 0 : 1));
  const zeroed = values.map((v) => (Number.isNaN(v) ? 0 : v));
  const [h, wh] = pass(zeroed, valid, true);
  const [v, wv] = pass(h, wh, false);
  const ones = new Float32Array(values.length).fill(1);
  const [, wo1] = pass(ones, ones, true);
  const [, wo] = pass(wo1, wo1, false);
  return {
    values: values.map((d, i) =>
      wv[i] <= 0
        ? NaN
        : Number.isNaN(d)
          ? v[i] / wv[i]
          : Math.min(v[i] / wv[i], d),
    ),
    cover: wv.map((w, i) => w / wo[i]),
  };
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
 * coordinates. Marching squares interpolating the depth linearly between pixel centres,
 * as the bands' edges are, so a contour lies on the edge its bands share. */
function isoline(r: Raster, level: number): Point[][] {
  const { n, halo, size, depth } = r;
  const v = (x: number, y: number) => depth[(y + halo) * size + x + halo];
  const c = (x: number, y: number) => {
    const i = (y + halo) * size + x + halo;
    return Math.max((r.cover[i] - 0.5) * 100, r.measuredM - r.near[i]);
  };
  const corners = (x: number, y: number) => [
    c(x, y),
    c(x + 1, y),
    c(x + 1, y + 1),
    c(x, y + 1),
  ];
  const scale = EXTENT / n;
  const segments: [Point, Point][] = [];
  // Pixel centres sit at +0.5; a crossing is where the depth between two reaches level.
  const mid = (ax: number, ay: number, bx: number, by: number): Point => {
    const t = (level - v(ax, ay)) / (v(bx, by) - v(ax, ay));
    return [
      Math.round((ax + (bx - ax) * t + 0.5) * scale),
      Math.round((ay + (by - ay) * t + 0.5) * scale),
    ];
  };
  const b = Math.min(BUFFER_PX, halo - 1);
  for (let y = -1 - b; y < n + b; y++) {
    for (let x = -1 - b; x < n + b; x++) {
      const q = [v(x, y), v(x + 1, y), v(x + 1, y + 1), v(x, y + 1)];
      if (q.some((d) => d === undefined || Number.isNaN(d))) continue;
      if (corners(x, y).some((e) => !(e >= 0))) continue;
      const b = q.map((d) => (d >= level ? 1 : 0));
      const code = b[0] | (b[1] << 1) | (b[2] << 2) | (b[3] << 3);
      if (code === 0 || code === 15) continue;
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
  const r = surface(z, x, y, cells);
  const { depth } = r;
  const has = (i: number) =>
    !Number.isNaN(depth[i]) && depth[i] <= MAX_AREA_DEPTH_M;
  // At least 0 where half the neighbourhood has a depth, or within a cell of a sounded
  // cell, so the boat's own track always draws: the surface's edge, in metres. Scaled so
  // it decides the edge, and the depth the bands within it.
  const edge = (i: number) =>
    Math.max((r.cover[i] - 0.5) * 100, r.measuredM - r.near[i]);
  // Just outside the surface, how far outside, so an edge falls between pixels rather
  // than on the last one with a depth, and a lone pixel draws as more than a point.
  const outside = (i: number) =>
    Number.isFinite(r.near[i]) ? Math.min(edge(i), -BAND_EPS_M) : -1;

  const DEPARE: Feature[] = [];
  const bands: [number, number][] = [
    [DRYING_FLOOR_M, 0],
    ...LEVELS.slice(0, -1).map(
      (lo, i) => [lo, LEVELS[i + 1]] as [number, number],
    ),
  ];
  for (const [lo, hi] of bands) {
    // At least 0 inside the band, crossing 0 where the depth reaches either edge.
    const polys = polygons(r, (i) =>
      // A band holds its lower edge, not its upper: a depth of exactly 0 m, which the
      // margin clamps shallow water to, is wet, not drying.
      has(i)
        ? Math.min(depth[i] - lo, hi - depth[i] - BAND_EPS_M, edge(i))
        : outside(i),
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
    const lines = isoline(r, level);
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
    INFORM,
    ...(Number.isFinite(first)
      ? { SURSTA: date(first), SUREND: date(last) }
      : {}),
  };
  const M_QUAL: Feature[] = [];
  // Coverage edges follow the distance to the nearest sounded cell.
  const measured = polygons(r, (i) =>
    Number.isFinite(r.near[i]) ? r.measuredM - r.near[i] : -1,
  );
  if (measured.length) {
    M_QUAL.push({
      type: "Polygon",
      polygons: measured,
      properties: { ...quality, kind: "measured" },
    });
  }
  const between = polygons(r, (i) =>
    has(i) ? Math.min(r.near[i] - r.measuredM, edge(i)) : outside(i),
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
