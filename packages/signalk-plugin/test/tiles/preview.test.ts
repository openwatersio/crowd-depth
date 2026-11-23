import { expect, test } from "vitest";
import { createDB } from "../../src/storage.js";
import { createCellStore, type Pass } from "../../src/tiles/cells.js";
import {
  cellAt,
  cellCenter,
  tileBounds,
  tileFraction,
  tileMetres,
} from "../../src/tiles/geometry.js";
import { EXTENT } from "../../src/tiles/mvt.js";
import { cut, prepare } from "../../src/tiles/portray.js";
import {
  FOCUS_M,
  PREVIEW_MIN_MS,
  createPreview,
  previewWindow,
  readPreview,
  windowBounds,
  type GeoFeature,
  type PreviewRequest,
} from "../../src/tiles/preview.js";
import {
  FINE_ZOOM,
  MAX_ZOOM,
  PIXEL_ZOOM,
  areasAndContours,
  rasterSize,
  sharedTile,
  surface,
} from "../../src/tiles/surface.js";

const LON = -76.2;
const LAT = 36.98;
const M_PER_DEG_LAT = 110540;
const mPerDegLon = 111320 * Math.cos((LAT * Math.PI) / 180);

/** Passes along a line east from (LON, LAT), a cell apart, shoaling from 6 m to 2 m. */
function passes(n: number, dLat = 0): Pass[] {
  return Array.from({ length: n }, (_, i) => {
    const { py, px } = cellAt(
      LON + (i * 20) / mPerDegLon,
      LAT + dLat + Math.sin(i / 8) * (60 / M_PER_DEG_LAT),
    );
    return { py, px, depth: 6 - (4 * i) / n, day: 20_000, tide: 0.1 };
  });
}

const request = (p: Pass[], written: Pass[] = []): PreviewRequest => ({
  ...previewWindow(
    [...p, ...written].map((c) => cellCenter(c.py, c.px)),
    cellCenter(p.at(-1)!.py, p.at(-1)!.px),
  ),
  passes: p,
  shoals: [],
  written: written.map(({ py, px }) => ({ py, px })),
});

/** Metres from a position to the nearest of `points`. */
const nearest = (lon: number, lat: number, points: number[][]) =>
  Math.min(
    ...points.map(([x, y]) =>
      Math.hypot((x - lon) * mPerDegLon, (y - lat) * M_PER_DEG_LAT),
    ),
  );

/** Every vertex of the features, as [lon, lat]. */
const points = (fs: GeoFeature[]) =>
  fs.flatMap(
    (f) =>
      (f.geometry.coordinates as unknown[]).flat(
        f.geometry.type === "MultiPolygon" ? 2 : 1,
      ) as number[][],
  );
const vertices = (f: GeoFeature) => points([f]);

/** Metres from a position to the nearest of `lines`. */
function toLines(lon: number, lat: number, lines: number[][][]) {
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = [
        (line[i - 1][0] - lon) * mPerDegLon,
        (line[i - 1][1] - lat) * M_PER_DEG_LAT,
      ];
      const [bx, by] = [
        (line[i][0] - lon) * mPerDegLon,
        (line[i][1] - lat) * M_PER_DEG_LAT,
      ];
      const [dx, dy] = [bx - ax, by - ay];
      const t = Math.max(
        0,
        Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)),
      );
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

test("the window reaches FOCUS_M past every position, at most a kilometre a side", () => {
  const p = passes(30).map((c) => cellCenter(c.py, c.px));
  const w = previewWindow(p, p.at(-1)!);
  const b = windowBounds(w.x, w.y, w.span);
  for (const { lon, lat } of p) {
    expect((lon - b.west) * mPerDegLon).toBeGreaterThanOrEqual(FOCUS_M);
    expect((b.east - lon) * mPerDegLon).toBeGreaterThanOrEqual(FOCUS_M);
    expect((lat - b.south) * M_PER_DEG_LAT).toBeGreaterThanOrEqual(FOCUS_M);
    expect((b.north - lat) * M_PER_DEG_LAT).toBeGreaterThanOrEqual(FOCUS_M);
  }
  // Ten kilometres of track: a window about the newest.
  const far = [
    { lon: LON - 0.12, lat: LAT },
    { lon: LON, lat: LAT },
  ];
  const capped = previewWindow(far, far[1]);
  const cb = windowBounds(capped.x, capped.y, capped.span);
  expect(capped.span * tileMetres(PIXEL_ZOOM, LAT)).toBeLessThan(1200);
  expect(LON).toBeGreaterThan(cb.west);
  expect(LON).toBeLessThan(cb.east);
});

test("on new water, the passes draw as depth areas and contours, only near them", () => {
  const store = createCellStore(createDB(":memory:"));
  // Half a kilometre: all inside the window.
  const p = passes(25);
  const features = readPreview(store, request(p));
  const areas = features.filter((f) => f.properties.DRVAL1 !== undefined);
  const contours = features.filter((f) => f.properties.VALDCO !== undefined);
  expect(areas.length).toBeGreaterThan(2);
  expect(contours.length).toBeGreaterThan(2);
  const track = p.map((c) => cellCenter(c.py, c.px)).map((c) => [c.lon, c.lat]);
  // A lone pass spreads a pixel or two; nothing reaches past the focus.
  for (const [lon, lat] of points(features)) {
    expect(nearest(lon, lat, track)).toBeLessThan(FOCUS_M + 5);
  }
  // Each pass's own water is drawn, in a band no deeper than its depth, since the
  // surface publishes m − kσ.
  for (const c of p) {
    const { lon, lat } = cellCenter(c.py, c.px);
    const under = areas.filter((a) =>
      (a.geometry.coordinates as number[][][][]).some((poly) =>
        inside(lon, lat, poly),
      ),
    );
    expect(under).toHaveLength(1);
    expect(Number(under[0].properties.DRVAL1)).toBeLessThanOrEqual(c.depth);
  }
});

/** Whether a position is inside a polygon's outer ring and none of its holes. */
function inside(lon: number, lat: number, rings: number[][][]) {
  const crossings = (ring: number[][]) => {
    let odd = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      )
        odd = !odd;
    }
    return odd;
  };
  return crossings(rings[0]) && !rings.slice(1).some(crossings);
}

test("pending passes draw as the cells will once they're written", () => {
  // Stored water the boat crosses again a metre shoaler: the preview of the pending
  // passes is the preview of the same passes once written.
  const before = passes(40).map((c) => ({ ...c, depth: c.depth + 1 }));
  const now = passes(40);
  const pending = createCellStore(createDB(":memory:"));
  pending.addPasses(before);
  const written = createCellStore(createDB(":memory:"));
  written.addPasses(before);
  written.addPasses(now);
  const a = readPreview(pending, request(now));
  const b = readPreview(written, { ...request(now), passes: [], written: now });
  expect(a).toEqual(b);
  // And not as the stored cells alone.
  expect(
    readPreview(pending, { ...request(now), passes: [], written: now }),
  ).not.toEqual(a);
});

test("where the data agrees, the preview's contours lie on the tile's", () => {
  // The track stored, its tiles drawn from it; the preview over it with nothing pending.
  const store = createCellStore(createDB(":memory:"));
  const p = passes(40);
  store.addPasses(p);
  const preview = readPreview(store, { ...request(p), passes: [], written: p });

  // A MAX_ZOOM tile as `buildTile` traces it, its contours in degrees.
  const mid = cellCenter(p[20].py, p[20].px);
  const f = tileFraction(mid.lon, mid.lat, MAX_ZOOM);
  const [x, y] = [Math.floor(f.x), Math.floor(f.y)];
  const a = sharedTile(MAX_ZOOM, x, y);
  const r = surface(a.z, a.x, a.y, store.cells(-77, 36, -75, 38), []);
  const n = rasterSize(MAX_ZOOM);
  const t = cut(prepare(r), (x - (a.x << a.k)) * n, (y - (a.y << a.k)) * n, n);
  const levels = [1, 2].map((m) => ({ m }));
  const tile = areasAndContours(t, true, levels, 0.5, 0.5).DEPCNT;
  const b = tileBounds(MAX_ZOOM, x, y);
  const toDeg = ([tx, ty]: number[]) => {
    const Y = y + ty / EXTENT;
    return [
      b.west + (tx / EXTENT) * (b.east - b.west),
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / 2 ** MAX_ZOOM))) * 180) /
        Math.PI,
    ];
  };
  let compared = 0;
  for (const level of levels) {
    const theirs = tile
      .filter((c) => c.properties.VALDCO === level.m)
      .flatMap((c) => (c.type === "LineString" ? c.lines : []))
      .map((line) => line.map(toDeg));
    const ours = preview
      .filter((c) => c.properties.VALDCO === level.m)
      .flatMap((c) => vertices(c));
    for (const [lon, lat] of ours) {
      // Inside the tile, away from its edges, where it's traced from its neighbours.
      const inset = 30;
      if (
        (lon - b.west) * mPerDegLon < inset ||
        (b.east - lon) * mPerDegLon < inset ||
        (lat - b.south) * M_PER_DEG_LAT < inset ||
        (b.north - lat) * M_PER_DEG_LAT < inset
      ) {
        continue;
      }
      expect(toLines(lon, lat, theirs)).toBeLessThan(1);
      compared++;
    }
  }
  expect(compared).toBeGreaterThan(20);
  // FINE_ZOOM is where both draw the fine contours compared here.
  expect(MAX_ZOOM).toBeGreaterThanOrEqual(FINE_ZOOM);
});

const line = (VALDCO: number): GeoFeature => ({
  type: "Feature",
  geometry: { type: "MultiLineString", coordinates: [] },
  properties: { VALDCO },
});

test("the same preview again, as at a berth, isn't a new one", async () => {
  let version = 1;
  let clock = 0;
  const preview = createPreview(
    {
      version: () => version,
      flushes: () => 0,
      pending: () => ({
        passes: passes(5),
        shoals: [],
        written: [],
        newest: { time: 0, depth: 3, lon: LON, lat: LAT },
      }),
    },
    async () => [line(1)],
    () => clock,
  );
  expect((await preview.get()).rev).toBe(1);
  version++;
  clock += PREVIEW_MIN_MS;
  expect((await preview.get()).rev).toBe(1);
});

test("worked out once per sounding come in, at most once a second, shared while it runs", async () => {
  let version = 1;
  let pending = { passes: passes(10), shoals: [], written: [] as Pass[] };
  const source = {
    version: () => version,
    flushes: () => 0,
    pending: () => ({
      ...pending,
      newest: { time: 0, depth: 3, lon: LON, lat: LAT },
    }),
  };
  let runs = 0;
  let clock = 0;
  const preview = createPreview(
    source,
    async () => {
      runs++;
      return [
        {
          type: "Feature",
          geometry: { type: "MultiLineString", coordinates: [] },
          properties: { VALDCO: runs },
        },
      ];
    },
    () => clock,
  );
  const [a, b] = await Promise.all([preview.get(), preview.get()]);
  expect(runs).toBe(1);
  expect(a).toEqual(b);
  expect(a.rev).toBe(1);
  // Nothing new: the same.
  expect(await preview.get()).toEqual(a);
  // A sounding, but within the second.
  version++;
  clock += PREVIEW_MIN_MS / 2;
  expect((await preview.get()).rev).toBe(1);
  clock += PREVIEW_MIN_MS;
  expect((await preview.get()).rev).toBe(2);
  expect(runs).toBe(2);

  // Not where the plotter isn't looking, until it is.
  version++;
  clock += PREVIEW_MIN_MS;
  expect((await preview.get([0, 0, 1, 1])).rev).toBe(2);
  expect(runs).toBe(2);
  expect((await preview.get([LON - 1, LAT - 1, LON + 1, LAT + 1])).rev).toBe(3);

  // Once everything's written and its tiles have caught up, cleared, sounding or not.
  pending = { passes: [], shoals: [], written: [] };
  clock += PREVIEW_MIN_MS;
  const cleared = await preview.get();
  expect(cleared).toEqual({ rev: 4, features: [] });
  expect(runs).toBe(3);
});

test("a preview that fails, or can't be taken, is tried again with the next sounding", async () => {
  let version = 1;
  let fail = true;
  let clock = 1000;
  const source = {
    version: () => version,
    flushes: () => 0,
    pending: () => ({
      passes: passes(5),
      shoals: [],
      written: [],
      newest: { time: 0, depth: 3, lon: LON, lat: LAT },
    }),
  };
  const preview = createPreview(
    source,
    async () => {
      if (fail) throw new Error("thread gone");
      return [line(version)];
    },
    () => clock,
  );
  // Counted from the clock, so a restart's don't match a runtime's.
  expect((await preview.get()).rev).toBe(1000);
  fail = false;
  clock += PREVIEW_MIN_MS;
  expect((await preview.get()).rev).toBe(1000);
  version++;
  expect((await preview.get()).rev).toBe(1001);
  // One the plugin couldn't take, as from positions it can't place: drawn as it was.
  source.pending = () => {
    throw new Error("bad sounding");
  };
  version++;
  clock += PREVIEW_MIN_MS;
  expect((await preview.get()).rev).toBe(1001);
});

test("a preview that read the cells across a write of its passes is worked out again", async () => {
  let flushes = 0;
  let runs = 0;
  let clock = 0;
  const preview = createPreview(
    {
      version: () => 1,
      flushes: () => flushes,
      pending: () => ({
        passes: passes(5),
        shoals: [],
        written: [],
        newest: { time: 0, depth: 3, lon: LON, lat: LAT },
      }),
    },
    async () => {
      // The writer writes the passes while the thread reads the cells.
      if (++runs === 1) flushes++;
      return [line(runs)];
    },
    () => clock,
  );
  expect((await preview.get()).rev).toBe(0);
  clock += PREVIEW_MIN_MS;
  // With no new sounding.
  expect((await preview.get()).rev).toBe(1);
  expect(runs).toBe(2);
});
