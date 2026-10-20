import { expect, test } from "vitest";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import { Cell, cellDepth } from "../../src/tiles/cells.js";
import { cellAt, tileFraction } from "../../src/tiles/geometry.js";
import { buildTile, contourLevels } from "../../src/tiles/surface.js";

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
