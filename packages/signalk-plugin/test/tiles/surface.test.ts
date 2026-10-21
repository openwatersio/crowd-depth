import { expect, test } from "vitest";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import { Cell, cellDepth } from "../../src/tiles/cells.js";
import { cellAt, cellCenter, tileFraction } from "../../src/tiles/geometry.js";
import { createDB } from "../../src/storage.js";
import { createCellStore } from "../../src/tiles/index.js";
import { readTile } from "../../src/tiles/service.js";
import { buildTile, contourLevels, surface } from "../../src/tiles/surface.js";

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

test("an unconfirmed shoal publishes as a flagged sounding, the interpolated surface drawn as if it weren't there", () => {
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

/** 12 m water in an L three cells wide, from the cell at `lon`, `lat`. */
function corner(lon = LON, lat = LAT) {
  const o = cellAt(lon, lat);
  const passes = [];
  for (let r = 0; r < 30; r++) {
    for (let c = 0; c < 30; c++) {
      if (r < 3 || c < 3) passes.push({ py: o.py + r, px: o.px + c });
    }
  }
  return { o, passes };
}

test("water carried past the surface is never deeper than a shoal beside it", () => {
  // The blur carries the 12 m water into the L's inner corner, past the pixels the
  // interpolation reaches; a 3 m shoal sits there.
  const { o, passes } = corner();
  const cells = passes.map((p) => ({
    ...p,
    m: 12,
    d: 0.2,
    passes: 3,
    first: 20000,
    last: 20010,
  }));
  const p = cellCenter(o.py + 3, o.px + 3);
  const shoal = { lon: p.lon, lat: p.lat, depth: 3, time: 0 };
  const without = surface(Z, tile.x, tile.y, cells);
  const capped = surface(Z, tile.x, tile.y, cells, [shoal]);
  const changed = [...capped.depth.keys()].filter(
    (i) => !Object.is(capped.depth[i], without.depth[i]),
  );
  expect(changed.length).toBeGreaterThan(0);
  for (const i of changed) expect(capped.depth[i]).toBeLessThanOrEqual(3);
});

test("a shoal just past a tile's edge caps the depths carried beside it", () => {
  // The L's corner just west of a tile's edge, and its 3 m shoal outside the tile: the
  // tile reads it over its margin.
  const f = tileFraction(LON, LAT, Z);
  const x = Math.floor(f.x) + 1;
  const y = Math.floor(f.y);
  const edgeLon = (x / 2 ** Z) * 360 - 180;
  const { o, passes } = corner(edgeLon - 0.0007, LAT);
  const store = createCellStore(createDB(":memory:"));
  store.addPasses(passes.map((p) => ({ ...p, depth: 12, day: 20000 })));
  const bands = () =>
    features(decode(readTile(store, Z, x, y)!), "DEPARE").map(
      (a) => a.properties.DRVAL1,
    );
  // Only 12 m water, less its margin.
  expect(bands().every((lo) => lo >= 5)).toBe(true);
  const p = cellCenter(o.py + 3, o.px + 3);
  expect(tileFraction(p.lon, p.lat, Z).x).toBeLessThan(x);
  store.addShoals([{ lon: p.lon, lat: p.lat, depth: 3, time: 0 }]);
  // The water carried beside it, in this tile, is drawn no deeper than it.
  expect(bands().some((lo) => lo < 3)).toBe(true);
  // It publishes in its own tile, not this one.
  const t = decode(readTile(store, Z, x, y)!);
  expect(features(t, "SOUNDG").filter((s) => s.properties.unconfirmed)).toEqual(
    [],
  );
});
