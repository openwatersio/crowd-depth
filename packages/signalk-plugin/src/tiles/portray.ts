// How a tile's surface is drawn: depth areas, contours and coverage, traced from one
// smooth surface, as a chart of crowd soundings draws them (docs/plans/global-grid/
// live-layer.md). The surface is blurred, never deeper than a sounding beside it, and
// upsampled before it's traced, so its contours curve as the bottom does rather than
// following the cells.
import { contours } from "d3-contour";
import { EXTENT, Point } from "./mvt.js";
import type { Raster } from "./surface.js";

/** Contour levels, in metres, a contour's unit, and whether it's one of every five. */
export interface Level {
  m: number;
  unit?: "m" | "ft";
  major?: boolean;
}

/** A blur of 1.5 pixels: enough to calm the cells' noise, little enough to keep a
 * channel's shape. */
const SMOOTH_PX = 1.5;
/** Raster pixels a side past the tile traced, which the renderer clips, so edges meet
 * across tiles; and the bicubic's reach past them. */
const BUFFER_PX = 3;
const SUPPORT_PX = 2;
/** Samples a tile side is upsampled to, at least. */
const SAMPLES = 160;

/** The tile's surface as traced: upsampled, with the fields its edges come from, each
 * about the distance in samples to its edge, so where two meet the lesser is where both
 * are. */
export interface Traced {
  /** Samples a side, and per raster pixel. */
  m: number;
  u: number;
  depth: Float64Array;
  /** The depth before the margin where it's at or above 0 m: where water is wet. */
  wet: Float64Array;
  /** How fast each changes per sample. */
  depthSlope: Float64Array;
  wetSlope: Float64Array;
  /** At least 0 inside the surface's extent. */
  extent: Float64Array;
  /** At least 0 within a cell of a sounded cell: measured water. */
  measured: Float64Array;
  /** Tile coordinates of a sample's edge-based position. */
  toTile: (x: number) => number;
}

/** Pixels a side past a tile traced: its buffer and the bicubic's support. */
const PAD_PX = BUFFER_PX + SUPPORT_PX;

/** The smooth fields over a square of the raster, at its own pixels, before they're
 * upsampled: what tiles cut from the same raster share. */
export interface Prepared {
  w: number;
  depth: Float64Array;
  wet: Float64Array;
  extent: Float64Array;
  measured: Float64Array;
  /** The shoalest sounding in each pixel or beside it, softened; Infinity where none. */
  cap: Float64Array;
}

/** The smooth fields over the raster's tile and PAD_PX past it. */
export function prepare(r: Raster): Prepared {
  const { n, halo, size } = r;
  const pad = PAD_PX;
  const x0 = halo - pad;
  const w = n + 2 * pad;
  const at = (x: number, y: number) => (y + x0) * size + x + x0;
  const region = (f: (i: number) => number) => {
    const a = new Float64Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) a[y * w + x] = f(at(x, y));
    }
    return a;
  };

  // Sounded water, within a cell of a sounded cell; and the water the interpolation
  // fills in beyond it.
  const sounded = region((i) =>
    !Number.isNaN(r.depth[i]) && r.near[i] <= r.measuredM ? 1 : 0,
  );
  const between = region((i) =>
    !Number.isNaN(r.depth[i]) &&
    r.cover[i] >= 0.5 &&
    !(r.near[i] <= r.measuredM)
      ? 1
      : 0,
  );
  // Each grown a pixel all round, as the grid's surface is, so a lone pass stays
  // visible; the measured part never over interpolated water.
  const grow = (mask: Float64Array) =>
    mask.map((_, i) => {
      const x = i % w;
      const y = Math.floor(i / w);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < w && mask[yy * w + xx]) {
            return 1;
          }
        }
      }
      return 0;
    });
  const grown = grow(sounded.map((v, i) => v || between[i]));
  const grownMeasured = grow(sounded).map((v, i) => (between[i] ? 0 : v));

  // The depth blurred, then never deeper than the shoalest sounding in a pixel or beside
  // it; pixels without one carry the shoalest beside them, so the bicubic has values
  // past the edge.
  const cap = soften(
    region((i) => r.shoalest[i]),
    w,
  );
  const smooth = (v: Float64Array) => {
    const blurred = gauss(v, w, SMOOTH_PX);
    return carry(
      blurred.map((d, i) => (Number.isNaN(d) ? d : Math.min(d, cap[i]))),
      w,
    );
  };
  const depth = smooth(region((i) => r.depth[i]));
  const wet = smooth(region((i) => r.wet[i]));
  const extent = logit(gauss(grown, w, 1, false));
  // Interpolated water stays interpolated, however narrow: blurred less, so a strip a
  // pixel wide still reaches a half, and it outranks the measured.
  const interpolated = logit(gauss(between, w, 0.5, false));
  const measured = logit(gauss(grownMeasured, w, 1, false)).map((m, i) =>
    Math.min(m, -interpolated[i]),
  );

  return { w, depth, wet, extent, measured, cap };
}

/** The tile `n` pixels a side whose pixels start at (`ox`, `oy`) past PAD_PX in `p`,
 * traced: its square of the fields, upsampled. */
export function cut(p: Prepared, ox: number, oy: number, n: number): Traced {
  const w = n + 2 * PAD_PX;
  const u = Math.max(1, Math.round(SAMPLES / n));
  const slice = (v: Float64Array) => {
    const a = new Float64Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) a[y * w + x] = v[(y + oy) * p.w + x + ox];
    }
    return a;
  };
  const m = w * u;
  const scale = EXTENT / n;
  // Each sample never deeper than the cap of a pixel about it: upsampling blends past a
  // pixel's own depth.
  const caps = upsampleMin(slice(p.cap), w, u);
  const fine = upsample(slice(p.depth), w, u, true).map((d, i) =>
    Math.min(d, caps[i]),
  );
  const fineWet = upsample(slice(p.wet), w, u, true).map((d, i) =>
    Math.min(d, caps[i]),
  );
  return {
    m,
    u,
    depth: fine,
    wet: fineWet,
    depthSlope: slope(fine, m),
    wetSlope: slope(fineWet, m),
    extent: upsample(slice(p.extent), w, u, false).map((e) => e * u),
    measured: upsample(slice(p.measured), w, u, false).map((e) => e * u),
    toTile: (s: number) => Math.round((s / u - PAD_PX) * scale),
  };
}

/** A gaussian blur of the values that are numbers, normalised by how much of the window
 * holds them; NaN where none does. With `valid` false, every value counts. */
function gauss(v: Float64Array, w: number, sigma: number, valid = true) {
  const r = Math.ceil(3 * sigma);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) =>
    Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)),
  );
  const pass = (s: Float64Array, c: Float64Array, horizontal: boolean) => {
    const o = new Float64Array(s.length);
    const oc = new Float64Array(s.length);
    const step = horizontal ? 1 : w;
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const p = horizontal ? x : y;
        const i = y * w + x;
        let a = 0;
        let b = 0;
        for (let j = Math.max(-r, -p); j <= Math.min(r, w - 1 - p); j++) {
          a += k[j + r] * s[i + j * step];
          b += k[j + r] * c[i + j * step];
        }
        o[i] = a;
        oc[i] = b;
      }
    }
    return [o, oc];
  };
  const has = v.map((d) => (!valid || !Number.isNaN(d) ? 1 : 0));
  const zero = v.map((d, i) => (has[i] ? d : 0));
  const [h, hc] = pass(zero, has, true);
  const [s, c] = pass(h, hc, false);
  if (!valid) {
    // The share of the window inside the raster.
    const ones = new Float64Array(v.length).fill(1);
    const [, oc] = pass(ones, ones, true);
    const [, all] = pass(oc, oc, false);
    return s.map((a, i) => a / all[i]);
  }
  return s.map((a, i) => (c[i] > 1e-6 ? a / c[i] : NaN));
}

/**
 * `cap`, the shoalest sounding in each pixel or beside it, softened so it doesn't draw
 * squares where it binds: each pixel takes the mean of its 3×3's own shoalest in their
 * 3×3s. Each of those holds the pixel's own, so the mean is never deeper than it.
 */
function soften(cap: Float64Array, w: number) {
  const around = (v: Float64Array, pick: (vals: number[]) => number) =>
    v.map((_, i) => {
      const x = i % w;
      const y = Math.floor(i / w);
      const vals: number[] = [];
      for (let yy = Math.max(0, y - 1); yy <= Math.min(w - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          vals.push(v[yy * w + xx]);
        }
      }
      return pick(vals);
    });
  const least = around(cap, (vals) => Math.min(...vals));
  return around(least, (vals) => {
    const finite = vals.filter(Number.isFinite);
    return finite.length
      ? finite.reduce((a, b) => a + b, 0) / finite.length
      : Infinity;
  }).map((v, i) => Math.min(v, cap[i]));
}

/** Each pixel without a value takes the shoalest of its neighbours', a few times over. */
function carry(v: Float64Array, w: number) {
  let a = v;
  for (let pass = 0; pass < SUPPORT_PX + BUFFER_PX + 2; pass++) {
    const prev = a;
    a = prev.map((d, i) => {
      if (!Number.isNaN(d)) return d;
      const x = i % w;
      let best = NaN;
      for (const j of [
        x > 0 ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        i - w,
        i + w,
      ]) {
        if (j < 0 || j >= prev.length || Number.isNaN(prev[j])) continue;
        if (!(prev[j] >= best)) best = prev[j];
      }
      return best;
    });
  }
  return a;
}

/** About the distance in pixels to where `share` is a half, for a straight edge blurred
 * by a pixel: the log-odds over 1.7. */
function logit(share: Float64Array) {
  return share.map((c) => {
    const p = Math.min(Math.max(c, 1e-9), 1 - 1e-9);
    return Math.log(p / (1 - p)) / 1.7;
  });
}

/** `v`, `w` a side, sampled `u` times a pixel: each sample the least of the four pixels
 * about it. */
function upsampleMin(v: Float64Array, w: number, u: number) {
  const m = w * u;
  const o = new Float64Array(m * m);
  const get = (x: number, y: number) =>
    v[Math.max(0, Math.min(w - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  for (let Y = 0; Y < m; Y++) {
    const y = Math.floor((Y + 0.5) / u - 0.5);
    for (let X = 0; X < m; X++) {
      const x = Math.floor((X + 0.5) / u - 0.5);
      o[Y * m + X] = Math.min(
        get(x, y),
        get(x + 1, y),
        get(x, y + 1),
        get(x + 1, y + 1),
      );
    }
  }
  return o;
}

/**
 * `v`, `w` a side, sampled `u` times a pixel: bicubic (Catmull-Rom), never past the four
 * nearest values so it can't overshoot them, or bilinear. NaN past the values reads as
 * deep, outside any band the extent lets through.
 */
function upsample(v: Float64Array, w: number, u: number, cubic: boolean) {
  const m = w * u;
  const o = new Float64Array(m * m);
  const get = (x: number, y: number) => {
    const d =
      v[Math.max(0, Math.min(w - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
    return Number.isNaN(d) ? 1e4 : d;
  };
  const cr = (a: number, b: number, c: number, d: number, t: number) =>
    b +
    0.5 *
      t *
      (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  for (let Y = 0; Y < m; Y++) {
    const fy = (Y + 0.5) / u - 0.5;
    const y = Math.floor(fy);
    const ty = fy - y;
    for (let X = 0; X < m; X++) {
      const fx = (X + 0.5) / u - 0.5;
      const x = Math.floor(fx);
      const tx = fx - x;
      const p00 = get(x, y);
      const p10 = get(x + 1, y);
      const p01 = get(x, y + 1);
      const p11 = get(x + 1, y + 1);
      let s: number;
      if (cubic && u > 1) {
        const row = (yy: number) =>
          cr(get(x - 1, yy), get(x, yy), get(x + 1, yy), get(x + 2, yy), tx);
        s = cr(row(y - 1), row(y), row(y + 1), row(y + 2), ty);
        s = Math.min(
          Math.max(s, Math.min(p00, p10, p01, p11)),
          Math.max(p00, p10, p01, p11),
        );
      } else {
        s =
          (p00 * (1 - tx) + p10 * tx) * (1 - ty) +
          (p01 * (1 - tx) + p11 * tx) * ty;
      }
      o[Y * m + X] = s;
    }
  }
  return o;
}

/** How far each sample is past `level`, in samples: its depth's distance from the level
 * over how fast the depth changes there. Level 0 follows where water is wet. */
export function distance(t: Traced, level: number): Float64Array {
  // Within a centimetre of 0 m, where wet water meets drying.
  const [v, g] =
    Math.abs(level) < 0.01 ? [t.wet, t.wetSlope] : [t.depth, t.depthSlope];
  return v.map((d, i) => (d - level) / g[i]);
}

/** How fast `v` changes per sample, `m` a side; never quite flat, so flat water is far
 * from every level. */
function slope(v: Float64Array, m: number): Float64Array {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = i % m;
    const dx = (v[x < m - 1 ? i + 1 : i] - v[x > 0 ? i - 1 : i]) / 2;
    const dy = (v[i + m < v.length ? i + m : i] - v[i >= m ? i - m : i]) / 2;
    out[i] = Math.max(Math.hypot(dx, dy), 1e-3);
  }
  return out;
}

/** Polygons where `field` is at least 0, in tile coordinates. */
export function polygons(t: Traced, field: Float64Array): Point[][][] {
  if (!field.some((v) => v >= 0)) return [];
  const [shape] = contours().size([t.m, t.m]).thresholds([0])(
    Array.from(field),
  );
  return shape.coordinates.map((poly) =>
    poly.map((ring) =>
      simplifyRing(
        ring.map(([x, y]) => [t.toTile(x), t.toTile(y)] as Point),
        1,
      ),
    ),
  );
}

/**
 * The contours at each of `levels`, in metres, within the extent, as lines in tile
 * coordinates, simplified to within a tile unit; in one pass over the samples. Each
 * crosses where its distance does, as the bands' edges do, so a contour lies on the edge
 * its bands share.
 */
export function isolines(t: Traced, levels: number[]): Map<number, Point[][]> {
  const { m, extent, depth } = t;
  const sorted = [...levels].sort((a, b) => a - b);
  const segments = new Map<number, [Point, Point][]>(
    sorted.map((l) => [l, []]),
  );
  const at = (level: number, i: number) => {
    const wet = Math.abs(level) < 0.01;
    return (
      ((wet ? t.wet : depth)[i] - level) / (wet ? t.wetSlope : t.depthSlope)[i]
    );
  };
  // Sample centres sit at +0.5 in d3-contour's coordinates, which `toTile` takes.
  const mid = (
    f: number[],
    a: number,
    b: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ) => {
    const s = f[a] / (f[a] - f[b]);
    return [
      t.toTile(ax + (bx - ax) * s + 0.5),
      t.toTile(ay + (by - ay) * s + 0.5),
    ] as Point;
  };
  const f = [0, 0, 0, 0];
  for (let y = 0; y < m - 1; y++) {
    for (let x = 0; x < m - 1; x++) {
      const i = y * m + x;
      const c = [i, i + 1, i + m + 1, i + m];
      if (!(
        extent[c[0]] >= 0 &&
        extent[c[1]] >= 0 &&
        extent[c[2]] >= 0 &&
        extent[c[3]] >= 0
      )) {
        continue;
      }
      // The wet depth reads shoaler than the depth, so both bound the cell.
      let lo = Infinity;
      let hi = -Infinity;
      for (const j of c) {
        lo = Math.min(lo, depth[j], t.wet[j]);
        hi = Math.max(hi, depth[j], t.wet[j]);
      }
      for (const level of sorted) {
        if (level < lo) continue;
        if (level > hi) break;
        for (let k = 0; k < 4; k++) f[k] = at(level, c[k]);
        const code =
          (f[0] >= 0 ? 1 : 0) |
          (f[1] >= 0 ? 2 : 0) |
          (f[2] >= 0 ? 4 : 0) |
          (f[3] >= 0 ? 8 : 0);
        if (code === 0 || code === 15) continue;
        const top = mid(f, 0, 1, x, y, x + 1, y);
        const right = mid(f, 1, 2, x + 1, y, x + 1, y + 1);
        const bottom = mid(f, 3, 2, x, y + 1, x + 1, y + 1);
        const left = mid(f, 0, 3, x, y, x, y + 1);
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
        segments.get(level)!.push(...cases[code]);
      }
    }
  }
  return new Map(
    [...segments].map(([level, s]) => [
      level,
      join(s)
        .map((line) => {
          const [a, b] = [line[0], line[line.length - 1]];
          // A closed contour's ends meet: simplified as a ring.
          return a[0] === b[0] && a[1] === b[1]
            ? simplifyRing(line, 1)
            : simplify(line, 1);
        })
        // A loop round a single sample rounds to a point: not drawn.
        .filter((line) => new Set(line.map(([x, y]) => `${x},${y}`)).size > 2),
    ]),
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

/** A closed ring simplified, split at its farthest point from its first, since its two
 * ends meet and give Douglas-Peucker no chord. */
function simplifyRing(ring: Point[], tolerance: number): Point[] {
  if (ring.length < 5) return ring;
  const [x0, y0] = ring[0];
  let k = 1;
  ring.forEach(([x, y], i) => {
    if (
      (x - x0) ** 2 + (y - y0) ** 2 >
      (ring[k][0] - x0) ** 2 + (ring[k][1] - y0) ** 2
    ) {
      k = i;
    }
  });
  const a = simplify(ring.slice(0, k + 1), tolerance);
  const b = simplify(ring.slice(k), tolerance);
  return [...a, ...b.slice(1)];
}

/** Douglas-Peucker: the fewest of `points` within `tolerance` of the line. */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const l = Math.hypot(dx, dy) || 1;
    let far = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d =
        Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / l;
      if (d > far) {
        far = d;
        at = i;
      }
    }
    if (far > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
