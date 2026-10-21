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

/** How far from its pixel's centre a carried cap holds, pixels: over the pixels beside it
 * too, since upsampling blends theirs with its own. Past that it rises CONE_M_PER_PX
 * metres a pixel, as far as CONE_PX pixels about it, by when it's 3.8 m deeper, deeper
 * than water beside a sounding seldom is. */
const HOLD_PX = 1.6;
const CONE_PX = 3;
const CONE_M_PER_PX = 2;
/** A blur of 1.5 pixels: enough to calm the cells' noise, little enough to keep a
 * channel's shape. */
const SMOOTH_PX = 1.5;
/** How much deeper than the surface beside it the blur may draw a pixel: half a metre,
 * as smooth as the surface allows without carrying deep water over shoal. */
const TOLERANCE_M = 0.5;
/** Raster pixels a side past the tile traced, which the renderer clips, so edges meet
 * across tiles; and the bicubic's reach past them. */
const BUFFER_PX = 3;
const SUPPORT_PX = 2;
/** Samples a tile side is upsampled to, at least. */
const SAMPLES = 256;

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
  /** Each pixel's softened cap past the interpolated pixels: Infinity where none. */
  carried: Float64Array;
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

  // The depth blurred, then past the interpolated pixels never deeper than a sounding
  // beside them; pixels without one carry the shoalest beside them, so the bicubic has
  // values past the edge. Within them, never more than TOLERANCE_M deeper than the
  // pixel's own surface depth, so the blur smooths it without carrying deep water over
  // shoal; its own, not the shoalest beside it, whose squares the contours would trace.
  const raw = region((i) => r.depth[i]);
  const carried = soften(
    region((i) => r.shoalest[i]),
    w,
  );
  const cap = carried.map((c, i) =>
    Number.isNaN(raw[i]) ? c : Math.min(c, raw[i] + TOLERANCE_M),
  );
  const smooth = (v: Float64Array) => {
    const blurred = gauss(v, w, SMOOTH_PX);
    return carry(
      blurred.map((d, i) => (Number.isNaN(d) ? d : Math.min(d, cap[i]))),
      w,
    );
  };
  const depth = smooth(raw);
  const wet = smooth(region((i) => r.wet[i]));
  const extent = logit(gauss(grown, w, 1, false));
  // Interpolated water stays interpolated, however narrow: blurred less, so a strip a
  // pixel wide still reaches a half, and it outranks the measured.
  const interpolated = logit(gauss(between, w, 0.5, false));
  const measured = logit(gauss(grownMeasured, w, 1, false)).map((m, i) =>
    Math.min(m, -interpolated[i]),
  );

  return { w, depth, wet, extent, measured, carried };
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
  // Each sample never deeper than the cap of the pixel it's in or beside, since
  // upsampling blends past a pixel's own depth: each cap holds over a disc and rises
  // from there as a cone, so a cap that binds draws round, rather than as the square of
  // pixels it covers.
  const carried = slice(p.carried);
  const caps = new Float64Array(m * m).fill(Infinity);
  // Each cap stamped over the samples within CONE_PX of its pixel's centre.
  const reach = CONE_PX + 0.5;
  for (let qy = 0; qy < w; qy++) {
    for (let qx = 0; qx < w; qx++) {
      const v = carried[qy * w + qx];
      if (v === Infinity) continue;
      const [cx, cy] = [qx + 0.5, qy + 0.5];
      const [x0, x1] = [
        Math.max(0, Math.ceil((cx - reach) * u - 0.5)),
        Math.min(m - 1, Math.floor((cx + reach) * u - 0.5)),
      ];
      const [y0, y1] = [
        Math.max(0, Math.ceil((cy - reach) * u - 0.5)),
        Math.min(m - 1, Math.floor((cy + reach) * u - 0.5)),
      ];
      for (let Y = y0; Y <= y1; Y++) {
        const dy = (Y + 0.5) / u - cy;
        for (let X = x0; X <= x1; X++) {
          const d = Math.hypot((X + 0.5) / u - cx, dy);
          if (d > reach) continue;
          const c = v + CONE_M_PER_PX * Math.max(0, d - HOLD_PX);
          if (c < caps[Y * m + X]) caps[Y * m + X] = c;
        }
      }
    }
  }
  const fine = upsample(slice(p.depth), w, u, true).map((d, i) =>
    Math.min(d, caps[i]),
  );
  const fineWet = upsample(slice(p.wet), w, u, true).map((d, i) =>
    Math.min(d, caps[i]),
  );
  const depthSlope = slope(fine, m);
  return {
    m,
    u,
    depth: fine,
    wet: fineWet,
    depthSlope,
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
  if (!valid) {
    // Normalised by the share of the window inside the raster, a row's times a column's.
    const inside = new Float64Array(w).map((_, p) => {
      let a = 0;
      for (let j = Math.max(-r, -p); j <= Math.min(r, w - 1 - p); j++)
        a += k[j + r];
      return a;
    });
    const [h] = pass(v, v, true);
    const [s] = pass(h, h, false);
    return s.map((a, i) => a / (inside[i % w] * inside[Math.floor(i / w)]));
  }
  const has = v.map((d) => (Number.isNaN(d) ? 0 : 1));
  const zero = v.map((d) => (Number.isNaN(d) ? 0 : d));
  const [h, hc] = pass(zero, has, true);
  const [s, c] = pass(h, hc, false);
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
  // Only where each of them has one: past a sounding's reach, the pixel's own.
  return around(least, (vals) =>
    vals.every(Number.isFinite)
      ? vals.reduce((a, b) => a + b, 0) / vals.length
      : Infinity,
  ).map((v, i) => Math.min(v, cap[i]));
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

/**
 * `v`, `w` a side, sampled `u` times a pixel: bicubic (Catmull-Rom), never past the four
 * nearest values so it can't overshoot them, or bilinear. NaN past the values reads as
 * deep, outside any band the extent lets through.
 */
function upsample(v: Float64Array, w: number, u: number, cubic: boolean) {
  if (u === 1) return v.map((d) => (Number.isNaN(d) ? 1e4 : d));
  const m = w * u;
  const src = v.map((d) => (Number.isNaN(d) ? 1e4 : d));
  // Each sample's four source pixels along an axis, and their weights: Catmull-Rom's,
  // or linear; the same for rows and columns, so it's done in two passes.
  const taps = 4;
  const index = new Int32Array(m * taps);
  const weight = new Float64Array(m * taps);
  const near = new Int32Array(m);
  for (let X = 0; X < m; X++) {
    const f = (X + 0.5) / u - 0.5;
    const x = Math.floor(f);
    const t = f - x;
    near[X] = x;
    const ws =
      cubic && u > 1
        ? [
            0.5 * (-t + 2 * t * t - t * t * t),
            0.5 * (2 - 5 * t * t + 3 * t * t * t),
            0.5 * (t + 4 * t * t - 3 * t * t * t),
            0.5 * (-t * t + t * t * t),
          ]
        : [0, 1 - t, t, 0];
    for (let k = 0; k < taps; k++) {
      index[X * taps + k] = Math.max(0, Math.min(w - 1, x - 1 + k));
      weight[X * taps + k] = ws[k];
    }
  }
  const rows = new Float64Array(w * m);
  for (let y = 0; y < w; y++) {
    for (let X = 0; X < m; X++) {
      let s = 0;
      for (let k = 0; k < taps; k++) {
        s += weight[X * taps + k] * src[y * w + index[X * taps + k]];
      }
      rows[y * m + X] = s;
    }
  }
  const o = new Float64Array(m * m);
  const at = (x: number, y: number) =>
    src[Math.max(0, Math.min(w - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  for (let Y = 0; Y < m; Y++) {
    for (let X = 0; X < m; X++) {
      let s = 0;
      for (let k = 0; k < taps; k++) {
        s += weight[Y * taps + k] * rows[index[Y * taps + k] * m + X];
      }
      if (cubic && u > 1) {
        // Never past the four nearest values, so it can't overshoot them.
        const x = near[X];
        const y = near[Y];
        const a = at(x, y);
        const b = at(x + 1, y);
        const c = at(x, y + 1);
        const d = at(x + 1, y + 1);
        s = Math.min(Math.max(s, Math.min(a, b, c, d)), Math.max(a, b, c, d));
      }
      o[Y * m + X] = s;
    }
  }
  return o;
}

/** At least 0 where the depth is from `lo` to `hi`, metres, and inside the extent: each
 * as about its distance in samples, the depth's from a level as how far it's past it
 * over how fast it changes there. A level within a centimetre of 0 m follows where
 * water is wet. */
export function band(t: Traced, lo: number, hi: number): Float64Array {
  const pick = (level: number) =>
    Math.abs(level) < 0.01 ? [t.wet, t.wetSlope] : [t.depth, t.depthSlope];
  const [lv, lg] = pick(lo);
  const [hv, hg] = pick(hi);
  const out = new Float64Array(t.extent.length);
  for (let i = 0; i < out.length; i++) {
    const e = t.extent[i];
    out[i] = Math.min(e, (lv[i] - lo) / lg[i], (hi - hv[i]) / hg[i]);
  }
  return out;
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
  const { m } = t;
  // Traced over just the samples about where it's at least 0, and a sample past them.
  let [x0, y0, x1, y1] = [m, m, -1, -1];
  for (let i = 0; i < field.length; i++) {
    if (!(field[i] >= 0)) continue;
    const x = i % m;
    const y = (i - x) / m;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  if (x1 < 0) return [];
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(m - 1, x1 + 1);
  y1 = Math.min(m - 1, y1 + 1);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const crop = new Array<number>(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++)
      crop[y * cw + x] = field[(y + y0) * m + x + x0];
  }
  const [shape] = contours().size([cw, ch]).thresholds([0])(crop);
  return shape.coordinates.map((poly) =>
    poly.map((ring) =>
      simplifyRing(
        ring.map(([x, y]) => [t.toTile(x + x0), t.toTile(y + y0)] as Point),
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
        // A loop round a single sample rounds to a point, or a line to a dot: not
        // drawn. A straight line simplifies to its two ends, and is.
        .filter((line) => {
          const [a, b] = [line[0], line[line.length - 1]];
          const closed = a[0] === b[0] && a[1] === b[1];
          return (
            new Set(line.map(([x, y]) => `${x},${y}`)).size > (closed ? 2 : 1)
          );
        }),
    ]),
  );
}

/** Join segments that share ends into lines. */
function join(segments: [Point, Point][]): Point[][] {
  const id = (p: Point) => `${p[0]},${p[1]}`;
  const byStart = new Map<string, number[]>();
  const byEnd = new Map<string, number[]>();
  const add = (m: Map<string, number[]>, p: Point, i: number) => {
    const k = id(p);
    const l = m.get(k);
    if (l) l.push(i);
    else m.set(k, [i]);
  };
  segments.forEach(([a, b], i) => {
    add(byStart, a, i);
    add(byEnd, b, i);
  });
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
    // Back from its first segment too, which may sit midway along the line.
    for (;;) {
      const prev = byEnd.get(id(line[0]))?.find((j) => !used[j]);
      if (prev === undefined) break;
      used[prev] = 1;
      line.unshift(segments[prev][0]);
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
