import { expect, test } from "vitest";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import { Cell } from "../../src/tiles/cells.js";
import { cellAt, cellCenter, tileFraction } from "../../src/tiles/geometry.js";
import { EXTENT } from "../../src/tiles/mvt.js";
import { buildTile } from "../../src/tiles/surface.js";

const Z = 14;
const LON = -76.2;
const LAT = 36.98;
const tile = (() => {
  const f = tileFraction(LON, LAT, Z);
  return { x: Math.floor(f.x), y: Math.floor(f.y) };
})();

/** Cells along a meridian `lon`, every 2/3″ of latitude for about 600 m. */
function lane(lon: number, m: (i: number) => number): Cell[] {
  return Array.from({ length: 30 }, (_, i) => {
    const { py, px } = cellAt(lon, LAT - 0.003 + i / 5400);
    return { py, px, m: m(i), d: 0.2, passes: 3, first: 20000, last: 20010 };
  });
}

const decode = (buf: Buffer) => new VectorTile(new Pbf(buf));

/** Cells at rows and columns from the cell at LON, LAT, all at 12 m. */
function at(offsets: [number, number][]): Cell[] {
  const o = cellAt(LON, LAT);
  return offsets.map(([r, c]) => ({
    py: o.py + r,
    px: o.px + c,
    m: 12,
    d: 0.2,
    passes: 3,
    first: 20000,
    last: 20010,
  }));
}

/** The DEPARE bands, by DRVAL1, whose areas hold a position. */
function bandsAt(t: VectorTile, z: number, lon: number, lat: number) {
  const f = tileFraction(lon, lat, z);
  const x = (f.x - Math.floor(f.x)) * EXTENT;
  const y = (f.y - Math.floor(f.y)) * EXTENT;
  // Even-odd over every ring of a feature: its polygons, less their holes.
  const inside = (rings: { x: number; y: number }[][]) => {
    let c = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if (
          r[i].y > y !== r[j].y > y &&
          x < ((r[j].x - r[i].x) * (y - r[i].y)) / (r[j].y - r[i].y) + r[i].x
        ) {
          c = !c;
        }
      }
    }
    return c;
  };
  return features(t, "DEPARE")
    .filter((a) => inside(a.loadGeometry()))
    .map((a) => a.properties.DRVAL1);
}

const features = (t: VectorTile, layer: string) => {
  const l = t.layers[layer];
  return l ? Array.from({ length: l.length }, (_, i) => l.feature(i)) : [];
};

test.each(["north", "east", "northeast"])(
  "a lone pass heading %s draws over every cell it sounded, at every zoom",
  (heading) => {
    const cells = at(
      Array.from({ length: 40 }, (_, k) => [
        heading === "east" ? 0 : k,
        heading === "north" ? 0 : k,
      ]),
    );
    for (let z = 4; z <= 15; z++) {
      const p0 = cellCenter(cells[0].py, cells[0].px);
      const f = tileFraction(p0.lon, p0.lat, z);
      const t = decode(
        buildTile(z, Math.floor(f.x), Math.floor(f.y), cells, [])!,
      );
      for (const c of cells) {
        const p = cellCenter(c.py, c.px);
        const g = tileFraction(p.lon, p.lat, z);
        if (Math.floor(g.x) !== Math.floor(f.x)) continue;
        if (Math.floor(g.y) !== Math.floor(f.y)) continue;
        expect(bandsAt(t, z, p.lon, p.lat), `z${z}`).toHaveLength(1);
      }
    }
  },
  // Twelve zooms of tiles.
  20_000,
);

test("every depth area is covered, as measured or interpolated, never both", () => {
  // Two passes four cells apart, as in the notch.
  const cells = at(
    Array.from({ length: 40 }, (_, i) => [i % 20, i < 20 ? 0 : 5]),
  );
  const t = decode(buildTile(Z, tile.x, tile.y, cells, [])!);
  const inside = (
    rings: { x: number; y: number }[][],
    x: number,
    y: number,
  ) => {
    let c = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if (
          r[i].y > y !== r[j].y > y &&
          x < ((r[j].x - r[i].x) * (y - r[i].y)) / (r[j].y - r[i].y) + r[i].x
        ) {
          c = !c;
        }
      }
    }
    return c;
  };
  const areas = features(t, "DEPARE").map((f) => f.loadGeometry());
  const coverage = features(t, "M_QUAL").map((f) => f.loadGeometry());
  let drawn = 0;
  let uncovered = 0;
  let both = 0;
  for (let y = 0; y < EXTENT; y += 8) {
    for (let x = 0; x < EXTENT; x += 8) {
      if (!areas.some((a) => inside(a, x, y))) continue;
      drawn++;
      const kinds = coverage.filter((c) => inside(c, x, y)).length;
      if (kinds === 0) uncovered++;
      if (kinds > 1) both++;
    }
  }
  expect(drawn).toBeGreaterThan(0);
  // Slivers at most, where measured and interpolated water meet at the surface's edge,
  // which in two short passes is much of it.
  expect(uncovered / drawn).toBeLessThan(0.01);
  expect(both / drawn).toBeLessThan(0.002);
});

test("water a diagonal pass sounded stays measured beside interpolated water", () => {
  // Two passes heading northeast, five cells apart, with interpolated water between.
  const cells = at(
    Array.from({ length: 40 }, (_, i) => [i % 20, (i % 20) + (i < 20 ? 0 : 5)]),
  );
  const z = 15;
  const p0 = cellCenter(cells[5].py, cells[5].px);
  const f = tileFraction(p0.lon, p0.lat, z);
  const t = decode(buildTile(z, Math.floor(f.x), Math.floor(f.y), cells, [])!);
  const measured = features(t, "M_QUAL").filter(
    (m) => m.properties.kind === "measured",
  );
  expect(features(t, "M_QUAL").map((m) => m.properties.kind)).toContain(
    "interpolated",
  );
  for (const c of cells) {
    const p = cellCenter(c.py, c.px);
    const g = tileFraction(p.lon, p.lat, z);
    if (Math.floor(g.x) !== Math.floor(f.x)) continue;
    if (Math.floor(g.y) !== Math.floor(f.y)) continue;
    const x = (g.x - Math.floor(g.x)) * EXTENT;
    const y = (g.y - Math.floor(g.y)) * EXTENT;
    const inside = measured.some((m) => {
      let k = false;
      for (const r of m.loadGeometry()) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          if (
            r[i].y > y !== r[j].y > y &&
            x < ((r[j].x - r[i].x) * (y - r[i].y)) / (r[j].y - r[i].y) + r[i].x
          ) {
            k = !k;
          }
        }
      }
      return k;
    });
    expect(inside, `cell ${c.py},${c.px}`).toBe(true);
  }
});

test("zoomed out, passes a few pixels apart stay apart", () => {
  for (const z of [8, 10]) {
    const f = tileFraction(LON, LAT, z);
    const pm = (40075016.7 * Math.cos((LAT * Math.PI) / 180)) / 2 ** z / 256;
    const dLon = (6 * pm) / (111320 * Math.cos((LAT * Math.PI) / 180));
    const cells = [...lane(LON, () => 8), ...lane(LON + dLon, () => 8)];
    const t = decode(
      buildTile(z, Math.floor(f.x), Math.floor(f.y), cells, [])!,
    );
    expect(bandsAt(t, z, LON + dLon / 2, LAT), `z${z}`).toEqual([]);
  }
});

test("contours in shallow water don't follow the pixel grid", () => {
  // A swath six cells wide heading northeast, its depths varying a few tenths about
  // 3.6 m, about 1.5 m past the margin.
  const o = cellAt(LON, LAT);
  const cells: Cell[] = [];
  for (let r = 0; r < 40; r++) {
    for (let k = 0; k < 6; k++) {
      cells.push({
        py: o.py + r,
        px: o.px + r + k,
        m: 3.6 + 0.35 * Math.sin(r * 1.3 + k * 2.1),
        d: 0.2,
        passes: 3,
        first: 20000,
        last: 20010,
      });
    }
  }
  const z = 15;
  const p = cellCenter(o.py + 20, o.px + 22);
  const f = tileFraction(p.lon, p.lat, z);
  const t = decode(buildTile(z, Math.floor(f.x), Math.floor(f.y), cells, [])!);
  let longest = 0;
  for (const c of features(t, "DEPCNT")) {
    for (const line of c.loadGeometry()) {
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]];
        if (a.x === b.x || a.y === b.y) {
          longest = Math.max(longest, Math.hypot(b.x - a.x, b.y - a.y));
        }
      }
    }
  }
  expect(features(t, "DEPCNT").length).toBeGreaterThan(0);
  // A z15 pixel is 64 units: a straight run of a couple of pixels along the grid is
  // the grid's, not the bottom's.
  expect(longest).toBeLessThan(96);
});

test("straight contours across an even slope are drawn", () => {
  // Water deepening evenly eastward, across the whole of a z15 tile and past it.
  const z = 15;
  const f = tileFraction(LON, LAT, z);
  const o = cellAt(LON, LAT);
  const cells: Cell[] = [];
  for (let r = -60; r < 60; r++) {
    for (let c = -20; c < 20; c++) {
      cells.push({
        py: o.py + r,
        px: o.px + c,
        m: 10 + c * 0.25,
        d: 0.2,
        passes: 3,
        first: 20000,
        last: 20010,
      });
    }
  }
  const t = decode(buildTile(z, Math.floor(f.x), Math.floor(f.y), cells, [])!);
  const metres = features(t, "DEPCNT").filter((c) => c.properties.unit === "m");
  const bands = features(t, "DEPARE").length;
  expect(bands).toBeGreaterThan(2);
  // A contour between each pair of neighbouring bands.
  expect(metres.length).toBeGreaterThanOrEqual(bands - 1);
});
