// The live preview: the surface round the boat as the cells would draw it were every
// sounding held written now, sent with each poll as GeoJSON, so the plotter shows new
// water within a poll or two rather than the ~27 s QC and passes hold a sounding for
// (docs/plans/global-grid/live-layer-performance.md). Drawn under the tiles, which take
// over as they land.
import { CellStore, Pass, Shoal, addPass, type Cell } from "./cells.js";
import {
  M_PER_DEG_LAT,
  cellCenter,
  mPerDegLon,
  tileBounds,
  tileFraction,
  tileMetres,
} from "./geometry.js";
import { EXTENT, type Feature as TileFeature } from "./mvt.js";
import {
  MARGIN_M,
  PIXEL_ZOOM,
  areaBand,
  previewLayers,
  type Detail,
} from "./surface.js";
import type { Sounding } from "./writer.js";

/** How far from a pass not yet in a refreshed tile the preview draws: as far as the
 * surface spreads a lone pass, and where its new water meets the stored water's. Past
 * it, the tiles' surface stands. */
export const FOCUS_M = 100;
/** The widest window, in pixels a side, about a kilometre: it caps a preview's cost. */
const MAX_SPAN = 56;
/** A preview is worked out at most once per this long, however many plotters poll. */
export const PREVIEW_MIN_MS = 1000;

/** A window and what goes into it: the pending passes and shoals, and the cells written
 * lately, which with the passes are what's drawn about. */
export interface PreviewRequest {
  x: number;
  y: number;
  span: number;
  passes: Pass[];
  shoals: Shoal[];
  written: { py: number; px: number }[];
}

export interface GeoFeature {
  type: "Feature";
  geometry:
    | { type: "MultiPolygon"; coordinates: number[][][][] }
    | { type: "MultiLineString"; coordinates: number[][][] };
  properties: Record<string, string | number>;
}

/** The square of PIXEL_ZOOM tiles, surface pixels, reaching FOCUS_M past every
 * position `at`; at most MAX_SPAN a side, about the newest when they reach further. */
export function previewWindow(
  at: { lon: number; lat: number }[],
  newest: { lon: number; lat: number },
) {
  const r = FOCUS_M / tileMetres(PIXEL_ZOOM, newest.lat);
  // In a loop, not spread: a long hold can pend tens of thousands.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of at) {
    const f = tileFraction(p.lon, p.lat, PIXEL_ZOOM);
    [x0, y0] = [Math.min(x0, f.x), Math.min(y0, f.y)];
    [x1, y1] = [Math.max(x1, f.x), Math.max(y1, f.y)];
  }
  let x = Math.floor(x0 - r);
  let y = Math.floor(y0 - r);
  const span = Math.max(Math.floor(x1 + r) - x, Math.floor(y1 + r) - y) + 1;
  if (span > MAX_SPAN) {
    const f = tileFraction(newest.lon, newest.lat, PIXEL_ZOOM);
    x = Math.floor(f.x - MAX_SPAN / 2);
    y = Math.floor(f.y - MAX_SPAN / 2);
  }
  const n = 2 ** PIXEL_ZOOM;
  const side = Math.min(span, MAX_SPAN);
  // Not across the antimeridian or past the poles' rows.
  return {
    x: Math.max(0, Math.min(n - side, x)),
    y: Math.max(0, Math.min(n - side, y)),
    span: side,
  };
}

/** A window's bounds in degrees. */
export function windowBounds(x: number, y: number, span: number) {
  const a = tileBounds(PIXEL_ZOOM, x, y);
  const b = tileBounds(PIXEL_ZOOM, x + span - 1, y + span - 1);
  return { west: a.west, north: a.north, east: b.east, south: b.south };
}

/** The positions the preview draws about. */
const focusOf = (
  passes: Pass[],
  shoals: Shoal[],
  written: { py: number; px: number }[],
) => [
  ...[...passes, ...written].map((c) => cellCenter(c.py, c.px)),
  ...shoals.map(({ lon, lat }) => ({ lon, lat })),
];

/** The surface's margin in degrees, at least, as `readPreview` reaches it. */
const MARGIN_DEG = MARGIN_M / mPerDegLon(85);

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** A ring's area, twice over, in its own units. */
function area(ring: number[][]) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a;
}

/** The preview over a window: the stored cells under it and its margin with the pending
 * passes folded in, and the stored and pending shoals, as depth areas and contours. */
export function readPreview(
  store: CellStore,
  { x, y, span, passes, shoals, written }: PreviewRequest,
  detail: Detail = "high",
): GeoFeature[] {
  const b = windowBounds(x, y, span);
  const dLat = MARGIN_M / M_PER_DEG_LAT;
  const dLon = MARGIN_M / mPerDegLon(Math.min(Math.max(-b.south, b.north), 85));
  const [west, south, east, north] = [
    b.west - dLon,
    b.south - dLat,
    b.east + dLon,
    b.north + dLat,
  ];
  const inside = (lon: number, lat: number) =>
    lon >= west && lon <= east && lat >= south && lat <= north;
  const cells = new Map<string, Cell>(
    store.cells(west, south, east, north).map((c) => [`${c.py},${c.px}`, c]),
  );
  for (const p of passes) {
    const c = cellCenter(p.py, p.px);
    if (!inside(c.lon, c.lat)) continue;
    const k = `${p.py},${p.px}`;
    cells.set(k, addPass(cells.get(k), p));
  }
  const all = [
    ...store.shoals(west, south, east, north),
    ...shoals.filter((s) => inside(s.lon, s.lat)),
  ];
  const at = focusOf(passes, shoals, written).filter((p) =>
    inside(p.lon, p.lat),
  );
  if (!at.length) return [];
  const { DEPARE, DEPCNT } = previewLayers(
    x,
    y,
    span,
    [...cells.values()],
    all,
    { m: FOCUS_M, at },
    detail,
  );

  // Window units to degrees.
  const n = 2 ** PIXEL_ZOOM;
  const lonLat = ([px, py]: number[]) => {
    const X = x + (px / EXTENT) * span;
    const Y = y + (py / EXTENT) * span;
    return [
      round((X / n) * 360 - 180),
      round(
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / n))) * 180) / Math.PI,
      ),
    ];
  };
  const toGeo = (f: TileFeature): GeoFeature =>
    f.type === "Polygon"
      ? {
          type: "Feature",
          geometry: {
            type: "MultiPolygon",
            coordinates: f.polygons.flatMap((rings) => {
              // As the tile encoder does: rings simplified to nothing are dropped,
              // and a polygon whose outer ring is, holes and all.
              const kept = rings.filter(
                (ring, i) => i === 0 || area(ring) !== 0,
              );
              return area(kept[0]) === 0
                ? []
                : [kept.map((ring) => ring.map(lonLat))];
            }),
          },
          properties: {
            ...f.properties,
            // The chart's band, drawn zoomed out as the tiles draw it.
            coarse: areaBand(Number(f.properties.DRVAL1), false),
          },
        }
      : {
          type: "Feature",
          geometry: {
            type: "MultiLineString",
            coordinates: (f.type === "LineString" ? f.lines : []).map((l) =>
              l.map(lonLat),
            ),
          },
          properties: f.properties,
        };
  return [...DEPARE, ...DEPCNT].map(toGeo);
}

/** What the preview reads from the writer. */
export interface PreviewSource {
  /** Bumped with each sounding taken in and each QC verdict. */
  version(): number;
  /** Bumped with each write of passes to the cells. */
  flushes(): number;
  pending(): {
    passes: Pass[];
    shoals: Shoal[];
    written: { py: number; px: number }[];
    newest?: Sounding;
  };
}

/**
 * The preview, worked out on demand by `run`, as on a tile thread, and shared by every
 * plotter polling: again only once a sounding or QC's verdict has come in since, and
 * PREVIEW_MIN_MS after it was last; never while one's being worked out. Empty once
 * nothing is pending and nothing was stored lately, by when the tiles show it all.
 *
 * `run` reads the cells after the pending passes are taken, so one worked out across a
 * write of them would count them twice: it's dropped, and worked out again.
 */
export function createPreview(
  source: PreviewSource,
  run: (req: PreviewRequest) => Promise<GeoFeature[]>,
  now = () => Date.now(),
) {
  // From the clock, so a restart's revisions don't match those a runtime holds.
  let rev = now();
  let features: GeoFeature[] = [];
  let version = -1;
  let startedAt = -Infinity;
  let checkedAt = -Infinity;
  let running: Promise<void> | undefined;
  const current = () => ({ rev, features });

  const start = (
    v: number,
    stale: boolean,
    view?: readonly [number, number, number, number],
  ) => {
    const flushes = source.flushes();
    const { passes, shoals, written, newest } = source.pending();
    if (!newest || (!passes.length && !shoals.length && !written.length)) {
      version = v;
      if (features.length) {
        features = [];
        rev++;
      }
      return Promise.resolve(current());
    }
    if (!stale) return Promise.resolve(current());
    const w = previewWindow(focusOf(passes, shoals, written), newest);
    if (view) {
      const b = windowBounds(w.x, w.y, w.span);
      const [west, south, east, north] = view;
      // Across the antimeridian a view's west is east of its east: drawn anyway.
      if (
        west <= east &&
        (b.east < west || b.west > east || b.north < south || b.south > north)
      ) {
        return Promise.resolve(current());
      }
    }
    version = v;
    startedAt = now();
    // Only what's in the window and its margin, not a long hold's every pass.
    const b = windowBounds(w.x, w.y, w.span);
    const near = (lon: number, lat: number) =>
      lon >= b.west - MARGIN_DEG &&
      lon <= b.east + MARGIN_DEG &&
      lat >= b.south - MARGIN_DEG &&
      lat <= b.north + MARGIN_DEG;
    const inCell = (c: { py: number; px: number }) => {
      const p = cellCenter(c.py, c.px);
      return near(p.lon, p.lat);
    };
    running = run({
      ...w,
      passes: passes.filter(inCell),
      shoals: shoals.filter((s) => near(s.lon, s.lat)),
      written: written.filter(inCell),
    })
      .then(
        (f) => {
          if (source.flushes() !== flushes) {
            version = -1;
            return;
          }
          // The same again, as at a berth, isn't sent again.
          if (JSON.stringify(f) === JSON.stringify(features)) return;
          features = f;
          rev++;
        },
        () => {
          // Tried again with the next sounding.
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running.then(current);
  };

  return {
    /** The latest preview, as it stands. */
    latest: current,
    /** The latest preview, worked out again first where it's stale and `view`, as
     * west, south, east, north, if given, shows the window. */
    get(view?: readonly [number, number, number, number]) {
      if (running) return running.then(current);
      const v = source.version();
      const stale = v !== version && now() - startedAt >= PREVIEW_MIN_MS;
      // Checked even with no new sounding, as when the sounder has stopped.
      const ending =
        !stale && features.length > 0 && now() - checkedAt >= PREVIEW_MIN_MS;
      if (!stale && !ending) return Promise.resolve(current());
      checkedAt = now();
      try {
        return start(v, stale, view);
      } catch {
        // Drawn as it was, and tried again with the next sounding.
        version = v;
        return Promise.resolve(current());
      }
    },
  };
}

export type Preview = ReturnType<typeof createPreview>;
