// One chart tile of the live layer, built from the cells under it: the grid's depth
// surface (packages/grid/src/grid/surface.py, docs/plans/global-grid/surface.md) and its
// S-57 overlay layers (overlay.py), for one vessel.
//
// The grid works on its 2/3″ pixels per 1° tile. A chart tile here is a square raster in
// Web Mercator of at most 256 pixels a side, the power of two nearest a cell, so at the
// cells' zoom a pixel is about a cell; zoomed out, a pixel holds the shoalest of its cells, as
// the grid aggregates. Distances are in metres, so the radius, smoothing and blur mean
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

/** Raster pixels a side for a tile: at most 256, and a pixel about a cell. */
export function rasterSize(z: number, _lat?: number): number {
  // Sized by zoom alone, as at the equator, so neighbouring tiles share a pixel grid and
  // their areas meet without a seam. Away from it pixels are finer than a cell. A power
  // of two, so a tile's pixels are its parent's, and tiles past SHARED_ZOOM share
  // their parent's surface.
  const fit = tileMetres(z, 0) / CELL_M;
  return Math.min(256, 2 ** Math.max(0, Math.round(Math.log2(fit))));
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
  /** Past the interpolated pixels, the shoalest sounding in each pixel or beside it, a
   * cell's or an unconfirmed shoal's; Infinity where there's none, and over the
   * interpolated pixels. */
  shoalest: Float32Array;
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
 * `cells` and `shoals` in its pixel or beside it.
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

  // Carried past the interpolated pixels, a depth is never deeper than a published
  // sounding in its pixel or beside it, cell or unconfirmed shoal, as the grid
  // overlay's carried depths.
  const byCell = new Float32Array(size * size).fill(Infinity);
  for (const [i, s] of byPixel) byCell[i] = Math.min(byCell[i], s.depth);
  const byShoal = new Float32Array(size * size).fill(Infinity);
  for (const s of shoals) {
    const f = tileFraction(s.lon, s.lat, z);
    const sx = Math.floor((f.x - x) * n + halo);
    const sy = Math.floor((f.y - y) * n + halo);
    if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
    byShoal[sy * size + sx] = Math.min(byShoal[sy * size + sx], s.depth);
  }
  const shoalest = new Float32Array(size * size).fill(Infinity);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const carried = Number.isNaN(median[i]);
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
          const j = yy * size + xx;
          shoalest[i] = Math.min(
            shoalest[i],
            byCell[j],
            carried ? byShoal[j] : Infinity,
          );
        }
      }
      if (carried && !Number.isNaN(depth[i])) {
        depth[i] = Math.min(depth[i], shoalest[i]);
      }
      // The interpolated pixels follow their cells as the grid's do, capped by none.
      if (!carried) shoalest[i] = Infinity;
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
    wet,
  };
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
  const n = rasterSize(z);
  const t = cut(prepared, (x - (a.x << a.k)) * n, (y - (a.y << a.k)) * n, n);
  const fine = detail === "high" && z >= FINE_ZOOM;
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
    const polys = polygons(t, band(t, lo - EDGE_M, hi - EDGE_M));
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
