import { expect, test } from "vitest";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import { Cell, cellDepth } from "../../src/tiles/cells.js";
import { cellAt, cellCenter, tileFraction } from "../../src/tiles/geometry.js";
import { EXTENT } from "../../src/tiles/mvt.js";
import {
  buildTile,
  close,
  contourLevels,
  surface,
} from "../../src/tiles/surface.js";

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

test("a lone track draws its own ribbon of areas, measured, never past it", () => {
  const t = decode(
    buildTile(
      Z,
      tile.x,
      tile.y,
      lane(LON, () => 8),
      [],
    )!,
  );
  // 8 m less the margin, about 6 m: the 5 to 10 m band, along the track only.
  expect(features(t, "DEPARE").map((f) => f.properties.DRVAL1)).toEqual([5]);
  expect(features(t, "SOUNDG").length).toBeGreaterThan(0);
  const coverage = features(t, "M_QUAL");
  expect(coverage.map((f) => f.properties.kind)).toEqual(["measured"]);
  expect(coverage[0].properties).toMatchObject({
    CATZOC: 5,
    SURSTA: "20241004",
  });
});

test("water between two tracks within 200 m is interpolated, never past them", () => {
  // Two lanes about 90 m apart, 8 m and 16 m.
  const cells = [...lane(LON, () => 8), ...lane(LON + 0.001, () => 16)];
  const t = decode(buildTile(Z, tile.x, tile.y, cells, [])!);
  const areas = features(t, "DEPARE");
  expect(areas.length).toBeGreaterThan(0);
  const shoalest = Math.min(...cells.map(cellDepth));
  const deepest = Math.max(...cells.map(cellDepth));
  for (const a of areas) {
    expect(a.type).toBe(3);
    expect(a.properties.DRVAL1).toBeLessThanOrEqual(deepest);
    expect(a.properties.DRVAL2).toBeGreaterThan(shoalest);
  }
  const kinds = features(t, "M_QUAL").map((f) => f.properties.kind);
  expect(kinds).toEqual(["measured", "interpolated"]);
  // The 10 m contour runs between them: their depths less the margin are 6 and 14 m.
  expect(contourLevels(Z)).toContain(10);
  expect(features(t, "DEPCNT").map((f) => f.properties.VALDCO)).toEqual([10]);
  expect(areas.map((a) => a.properties.DRVAL1)).toEqual([5, 10]);
});

test("an unconfirmed shoal publishes as a flagged sounding, outside the surface", () => {
  const cells = [...lane(LON, () => 8), ...lane(LON + 0.001, () => 8)];
  const without = decode(buildTile(Z, tile.x, tile.y, cells, [])!);
  const shoal = { lon: LON + 0.0005, lat: LAT, depth: 1.2, time: 0 };
  const t = decode(buildTile(Z, tile.x, tile.y, cells, [shoal])!);
  const flagged = features(t, "SOUNDG").filter((f) => f.properties.unconfirmed);
  expect(flagged.map((f) => f.properties)).toEqual([
    expect.objectContaining({ depth_m: 1.2, QUASOU: 9, VALSOU: 1.2 }),
  ]);
  // The areas are drawn as if it weren't there.
  const bands = (v: VectorTile) =>
    features(v, "DEPARE").map((f) => f.properties.DRVAL1);
  expect(bands(t)).toEqual(bands(without));
});

test("a tile with nothing in it is empty", () => {
  expect(buildTile(Z, tile.x, tile.y, [], [])).toBeUndefined();
});

test("shallow water the margin takes to 0 m is wet, not drying", () => {
  // 1.5 m less the margin is under 0, clamped to 0 m.
  const cells = [...lane(LON, () => 1.5), ...lane(LON + 0.001, () => 1.5)];
  const t = decode(buildTile(Z, tile.x, tile.y, cells, [])!);
  const bands = features(t, "DEPARE").map((f) => f.properties.DRVAL1);
  expect(bands).toEqual([0]);
});

test("zoomed out, a tile still draws the cells under it", () => {
  const z = 6;
  const f = tileFraction(LON, LAT, z);
  const t = decode(
    buildTile(
      z,
      Math.floor(f.x),
      Math.floor(f.y),
      lane(LON, () => 8),
      [],
    )!,
  );
  expect(features(t, "DEPARE").length).toBeGreaterThan(0);
  expect(features(t, "M_QUAL").map((m) => m.properties.kind)).toContain(
    "measured",
  );
});

test("coverage says whether its water is reduced to chart datum", () => {
  const quality = (cells: Cell[]) =>
    features(decode(buildTile(Z, tile.x, tile.y, cells, [])!), "M_QUAL")[0]
      .properties;
  const tided = lane(LON, () => 8).map((c) => ({ ...c, t: 0.25 }));
  expect(quality(tided)).toMatchObject({ tided: 1 });
  expect(String(quality(tided).INFORM)).toContain("Reduced to chart datum");
  // One untided cell makes the tile untided.
  const mixed = [...tided.slice(1), lane(LON, () => 8)[0]];
  expect(quality(mixed)).toMatchObject({ tided: 0 });
  expect(String(quality(mixed).INFORM)).toContain("Not reduced for tide");
});

test("water carried past the surface is never deeper than a shoal beside it", () => {
  // An L of 12 m water three cells wide, and a 3 m shoal in its inner corner, where the
  // surface is grown past the interpolated pixels with the 12 m water carried.
  const cells = at(
    Array.from({ length: 900 }, (_, i) => [Math.floor(i / 30), i % 30]).filter(
      ([r, c]) => r < 3 || c < 3,
    ) as [number, number][],
  );
  const o = cellAt(LON, LAT);
  const p = cellCenter(o.py + 4, o.px + 4);
  const z = 15;
  const f = tileFraction(p.lon, p.lat, z);
  const shoal = { lon: p.lon, lat: p.lat, depth: 3, time: 0 };
  const t = decode(
    buildTile(z, Math.floor(f.x), Math.floor(f.y), cells, [shoal])!,
  );
  const bands = bandsAt(t, z, p.lon, p.lat);
  expect(bands).not.toHaveLength(0);
  for (const lo of bands) expect(lo).toBeLessThan(3);
});

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
);

test("a notch between two passes ending side by side is filled", () => {
  // Two passes four cells apart: the water between them is interpolated, but not past
  // their ends, where it has no cell beyond it, and would trace as a V.
  const cells = at(
    Array.from({ length: 40 }, (_, i) => [i % 20, i < 20 ? 0 : 5]),
  );
  const r = surface(Z, tile.x, tile.y, cells);
  const drawn = (i: number) => r.edge[i] >= 0 && !Number.isNaN(r.depth[i]);
  for (let y = 0; y < r.size; y++) {
    const row = Array.from({ length: r.size }, (_, x) => drawn(y * r.size + x));
    const first = row.indexOf(true);
    const last = row.lastIndexOf(true);
    if (first >= 0)
      expect(row.slice(first, last + 1), `row ${y}`).not.toContain(false);
  }
});

test("gaps of up to four pixels are closed, a 3×3 one kept", () => {
  const size = 20;
  const edge = new Float32Array(size * size).fill(1);
  const depth = new Float32Array(size * size).fill(5);
  const hole = (x0: number, y0: number, w: number) => {
    for (let y = y0; y < y0 + w; y++) {
      for (let x = x0; x < x0 + w; x++) edge[y * size + x] = -1;
    }
  };
  hole(2, 2, 2);
  hole(10, 10, 3);
  close(edge, edge.slice(), depth, size, true);
  expect(edge[2 * size + 2]).toBeGreaterThanOrEqual(0);
  expect(edge[11 * size + 11]).toBeLessThan(0);
});

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
  // Rounding to tile coordinates, and the corner cutting, leave slivers at most.
  expect(uncovered / drawn).toBeLessThan(0.002);
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
