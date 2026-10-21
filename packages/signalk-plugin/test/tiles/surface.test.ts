import { expect, test } from "vitest";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import { Cell, cellDepth } from "../../src/tiles/cells.js";
import { cellAt, cellCenter, tileFraction } from "../../src/tiles/geometry.js";
import { createDB } from "../../src/storage.js";
import { createCellStore } from "../../src/tiles/index.js";
import {
  clearShared,
  createTileService,
  readTile,
} from "../../src/tiles/service.js";
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

const tileAt = (z: number) => {
  const f = tileFraction(LON, LAT, z);
  return { x: Math.floor(f.x), y: Math.floor(f.y) };
};

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
  // Contours run between them every metre and every foot, their depths less the margin
  // 6 to 14 m, the 10 m one of every five; standard detail draws the chart's 10 m alone.
  const metres = features(t, "DEPCNT").filter((f) => f.properties.unit === "m");
  expect(metres.map((f) => f.properties.VALDCO)).toEqual(
    expect.arrayContaining([7, 8, 9, 10, 11, 12]),
  );
  expect(
    metres.filter((f) => f.properties.major).map((f) => f.properties.VALDCO),
  ).toEqual([10]);
  const standard = decode(buildTile(Z, tile.x, tile.y, cells, [], "standard")!);
  expect(contourLevels(Z)).toContain(10);
  expect(features(standard, "DEPCNT").map((f) => f.properties.VALDCO)).toEqual([
    10,
  ]);
  // Bands a metre each, from the shoal lane's 6 m to the deep one's 12 m.
  for (const a of areas) {
    expect(a.properties.DRVAL2 - a.properties.DRVAL1).toBe(1);
  }
  const los = areas.map((a) => a.properties.DRVAL1);
  expect(Math.min(...los)).toBeLessThanOrEqual(6);
  expect(Math.max(...los)).toBeGreaterThanOrEqual(12);
  expect(features(standard, "DEPARE").map((a) => a.properties.DRVAL1)).toEqual([
    5, 10,
  ]);
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
  // A lane of 12 m water two and a half pixels inside a tile, and a 2.5 m shoal half a
  // pixel outside it, past the surface its ancestor shares too: the tile reads it over
  // its margin, and the water grown past the lane beside it is drawn no deeper.
  const f = tileFraction(LON, LAT, Z);
  const x = (Math.floor(f.x) + 1) & ~1;
  const y = Math.floor(f.y);
  const n = 2 ** Z;
  const lonAt = (px: number) => ((x + px / 128) / n) * 360 - 180;
  const store = createCellStore(createDB(":memory:"));
  store.addPasses(
    Array.from({ length: 30 }, (_, i) => ({
      ...cellAt(lonAt(2.5), LAT - 0.003 + i / 5400),
      depth: 12,
      day: 20000,
    })),
  );
  const bands = () =>
    features(decode(readTile(store, Z, x, y)!), "DEPARE").map(
      (a) => a.properties.DRVAL1,
    );
  // Only 12 m water, less its margin.
  expect(bands().every((lo) => lo >= 5)).toBe(true);
  store.addShoals(
    Array.from({ length: 30 }, (_, i) => ({
      lon: lonAt(-0.5),
      lat: LAT - 0.003 + i / 5400,
      depth: 2.5,
      time: 0,
    })),
  );
  // As the tile service does when the shoals are written.
  clearShared(store);
  expect(bands().some((lo) => lo <= 2)).toBe(true);
  // Read over the margin, as cells are.
  const asked: number[][] = [];
  readTile(
    {
      ...store,
      cells: (...b: Parameters<typeof store.cells>) => (
        asked.push(b),
        store.cells(...b)
      ),
      shoals: (...b: Parameters<typeof store.shoals>) => (
        asked.push(b),
        store.shoals(...b)
      ),
    },
    Z,
    x,
    y,
  );
  expect(asked[1]).toEqual(asked[0].slice(0, 4));
  // They publish in their own tile, not this one.
  const t = decode(readTile(store, Z, x, y)!);
  expect(features(t, "SOUNDG").filter((s) => s.properties.unconfirmed)).toEqual(
    [],
  );
});

/** The DEPARE bands, by DRVAL1, whose areas hold a point in tile coordinates. */
function bandsHolding(t: VectorTile, x: number, y: number) {
  return features(t, "DEPARE")
    .filter((a) => {
      let c = false;
      for (const r of a.loadGeometry()) {
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
    })
    .map((a) => a.properties.DRVAL1);
}

test("upsampled, water beside a shoal is still no deeper than it", () => {
  // At z15, upsampled: a lane of 12 m water two and a half pixels inside the tile, and
  // 2.5 m shoals half a pixel outside it.
  const [z, x, y] = [15, 9448, 12756];
  const lonAt = (px: number) => ((x + px / 64) / 2 ** z) * 360 - 180;
  const lat = (i: number) => 36.977 + i / 5400;
  const cells: Cell[] = Array.from({ length: 30 }, (_, i) => ({
    ...cellAt(lonAt(2.5), lat(i)),
    m: 12,
    d: 0.2,
    passes: 3,
    first: 20000,
    last: 20010,
  }));
  const shoals = Array.from({ length: 30 }, (_, i) => ({
    lon: lonAt(-0.5),
    lat: lat(i),
    depth: 2.5,
    time: 0,
  }));
  const t = decode(buildTile(z, x, y, cells, shoals)!);
  // In the tile's first pixel, beside the shoals, no area is deeper.
  const unit = 4096 / 64;
  let seen = 0;
  for (let ty = 0; ty < 4096; ty += 8) {
    for (let tx = 0; tx < unit; tx += 4) {
      for (const lo of bandsHolding(t, tx, ty)) {
        seen++;
        expect(lo, `${tx},${ty}`).toBeLessThan(2.5);
      }
    }
  }
  expect(seen).toBeGreaterThan(0);
});

test("a contour closed round a bank stays closed", () => {
  // A 3 m bank in 9 m water, well inside the tile.
  const o = cellAt(LON, LAT);
  const cells: Cell[] = [];
  for (let r = 0; r < 25; r++) {
    for (let c = 0; c < 25; c++) {
      const bank = (r - 12) ** 2 + (c - 12) ** 2 < 16;
      cells.push({
        py: o.py + r,
        px: o.px + c,
        m: bank ? 5 : 11,
        d: 0.2,
        passes: 3,
        first: 20000,
        last: 20010,
      });
    }
  }
  const t = decode(buildTile(Z, tile.x, tile.y, cells, [])!);
  const loops = features(t, "DEPCNT")
    .filter((c) => c.properties.unit === "m")
    .flatMap((c) => c.loadGeometry())
    .filter((l) => {
      const [a, b] = [l[0], l[l.length - 1]];
      return a.x === b.x && a.y === b.y;
    });
  expect(loops.length).toBeGreaterThan(0);
  for (const l of loops) expect(l.length).toBeGreaterThan(4);
});

test("fine contours keep the chart's deeper than 50 m", () => {
  const cells = [...lane(LON, () => 85), ...lane(LON + 0.001, () => 135)];
  const t = decode(buildTile(Z, tile.x, tile.y, cells, [])!);
  expect(features(t, "DEPCNT").map((c) => c.properties.VALDCO)).toContain(100);
});

test("zoomed out, cells past one edge of a tile don't draw at its other", () => {
  // Cells just past the tile's east edge, in its margin.
  const z = 8;
  const f = tileFraction(LON, LAT, z);
  const x = Math.floor(f.x);
  const y = Math.floor(f.y);
  const east = ((x + 1) / 2 ** z) * 360 - 180;
  const cells = lane(east + 0.002, () => 8);
  const buf = buildTile(z, x, y, cells, []);
  const areas = buf ? features(decode(buf), "DEPARE") : [];
  for (const a of areas) {
    for (const r of a.loadGeometry()) {
      for (const p of r) expect(p.x).toBeGreaterThan(2048);
    }
  }
});

test("water between two tracks close together stays interpolated", () => {
  const cells = [...lane(LON, () => 10), ...lane(LON + 0.0005, () => 10)];
  const t = decode(buildTile(13, tileAt(13).x, tileAt(13).y, cells, [])!);
  expect(features(t, "M_QUAL").map((m) => m.properties.kind)).toContain(
    "interpolated",
  );
});

test("a tile is tided by its own cells, not the rest of its ancestor's", () => {
  // At z15, the tile's cells tided; one untided cell 2 km east, in the same z13 tile.
  const z = 15;
  const f = tileFraction(LON, LAT, z);
  const x = Math.floor(f.x);
  const y = Math.floor(f.y);
  const lonAt = (px: number) => ((x + px / 64) / 2 ** z) * 360 - 180;
  const cells: Cell[] = [
    ...lane(lonAt(32), () => 8).map((c) => ({ ...c, t: 0.25 })),
    { ...lane(LON + 0.02, () => 8)[0] },
  ];
  const t = decode(buildTile(z, x, y, cells, [])!);
  expect(features(t, "M_QUAL")[0].properties).toMatchObject({ tided: 1 });
});

test("zoomed out, a tile's areas follow a pass that changes its cells", async () => {
  const z = 12;
  const at = tileAt(z);
  const store = createCellStore(createDB(":memory:"));
  const tiles = createTileService(store);
  const pass = (depth: number) =>
    lane(LON, () => depth).map((c) => ({
      py: c.py,
      px: c.px,
      depth,
      day: 20000,
    }));
  store.addPasses(pass(8));
  const bands = async () =>
    features(decode((await tiles.get(z, at.x, at.y))!), "DEPARE").map(
      (a) => a.properties.DRVAL1,
    );
  const before = await bands();
  // The same water read much deeper on later passes.
  for (let k = 0; k < 20; k++) store.addPasses(pass(30));
  tiles.changed(lane(LON, () => 0).map((c) => cellCenter(c.py, c.px)));
  expect(await bands()).not.toEqual(before);
});
