import { describe, expect, it } from "vitest";
import {
  BASE_ZOOM,
  MIN_ZOOM,
  TILE_SIZE,
  cellSize,
  decodeTile,
  encodeDepth,
  encodeTile,
  lngLatToCell,
  mergeCell,
  minPoolTile,
  type TileCells,
} from "../../../src/tiles/core/grid.js";
import { createMemoryTileStore } from "../../../src/tiles/core/store.js";
import {
  createTileAccumulator,
  rebuildAncestors,
} from "../../../src/tiles/core/accumulator.js";
import {
  decodeTileSamples,
  tileCellCentre,
  tileRangeForBbox,
  zoomForCellSize,
} from "../../../src/tiles/core/tile-source.js";

const POS: [number, number] = [0.001, 0.001];

describe("bathymetry-tiles grid", () => {
  it("round-trips a tile through the sparse codec", () => {
    const cells: TileCells = new Map();
    mergeCell(cells, 10 * TILE_SIZE + 20, encodeDepth(12.34));
    mergeCell(cells, 5, encodeDepth(2));
    const decoded = decodeTile(encodeTile(cells));
    expect(decoded.get(10 * TILE_SIZE + 20)?.depth).toBe(1234);
    expect(decoded.get(5)?.depth).toBe(200);
  });

  it("min-pools a child tile down into its parent", () => {
    // A 2x2 block of cells at the child's top-left pools into parent cell 0.
    const block: TileCells = new Map([
      [0, { depth: 900, count: 1 }],
      [1, { depth: 700, count: 1 }],
      [TILE_SIZE, { depth: 800, count: 1 }],
      [TILE_SIZE + 1, { depth: 650, count: 1 }],
    ]);
    const parent = minPoolTile([block, undefined, undefined, undefined]);
    expect(parent.get(0)).toEqual({ depth: 650, count: 4 });
  });

  it("places each child in its own quadrant of the parent", () => {
    const ne = new Map([[0, { depth: 500, count: 1 }]]);
    const parent = minPoolTile([undefined, undefined, undefined, ne]);
    expect(parent.get(128 * TILE_SIZE + 128)).toEqual({
      depth: 500,
      count: 1,
    });
  });

  it("maps a lon/lat to the same cell that centres back to it", () => {
    const { x, y, cx, cy } = lngLatToCell(POS[0], POS[1], BASE_ZOOM);
    const [lon, lat] = tileCellCentre(BASE_ZOOM, x, y, cy * TILE_SIZE + cx);
    const again = lngLatToCell(lon, lat, BASE_ZOOM);
    expect([again.x, again.y, again.cx, again.cy]).toEqual([x, y, cx, cy]);
  });
});

describe("bathymetry-tiles memory store", () => {
  it("keeps the shallowest depth and sums counts on merge", () => {
    const store = createMemoryTileStore();
    const { x, y } = lngLatToCell(POS[0], POS[1], BASE_ZOOM);
    store.merge(BASE_ZOOM, x, y, new Map([[0, { depth: 1500, count: 1 }]]));
    store.merge(BASE_ZOOM, x, y, new Map([[0, { depth: 900, count: 1 }]]));
    expect(store.read(BASE_ZOOM, x, y)?.get(0)).toEqual({
      depth: 900,
      count: 2,
    });
  });

  it("deletes a tile when written empty", () => {
    const store = createMemoryTileStore();
    store.merge(BASE_ZOOM, 1, 1, new Map([[0, { depth: 100, count: 1 }]]));
    store.write(BASE_ZOOM, 1, 1, new Map());
    expect(store.read(BASE_ZOOM, 1, 1)).toBeUndefined();
  });
});

describe("bathymetry-tiles accumulator", () => {
  it("folds soundings into a tile and min-pools the ancestors", () => {
    const store = createMemoryTileStore();
    const accumulator = createTileAccumulator(store);
    accumulator.add({ lon: POS[0], lat: POS[1], depth: 12 });
    accumulator.add({ lon: POS[0], lat: POS[1], depth: 8 });
    accumulator.flush();

    const { x, y } = lngLatToCell(POS[0], POS[1], BASE_ZOOM);
    const cells = store.read(BASE_ZOOM, x, y);
    expect([...cells!.values()][0]).toEqual({ depth: 800, count: 2 });
    expect(store.read(BASE_ZOOM - 1, x >> 1, y >> 1)?.size).toBe(1);
  });

  it("ignores negative or non-finite soundings", () => {
    const store = createMemoryTileStore();
    const accumulator = createTileAccumulator(store);
    accumulator.add({ lon: POS[0], lat: POS[1], depth: -1 });
    accumulator.add({ lon: NaN, lat: POS[1], depth: 5 });
    expect(accumulator.pending).toBe(0);
  });

  it("rebuildAncestors builds the pyramid from the base tiles in one pass", () => {
    const store = createMemoryTileStore();
    const accumulator = createTileAccumulator(store, { ancestors: false });
    accumulator.add({ lon: POS[0], lat: POS[1], depth: 5 });
    accumulator.flush();

    const { x, y } = lngLatToCell(POS[0], POS[1], BASE_ZOOM);
    expect(store.read(BASE_ZOOM, x, y)?.size).toBe(1);
    expect(store.listTiles(BASE_ZOOM - 1).length).toBe(0);

    rebuildAncestors(store);
    const top = store.listTiles(MIN_ZOOM);
    expect(top.length).toBe(1);
    expect(
      [...store.read(MIN_ZOOM, top[0].x, top[0].y)!.values()][0].depth,
    ).toBe(500);
  });
});

describe("bathymetry-tiles tile source", () => {
  it("picks the finest tile level no coarser than the target cell size", () => {
    expect(zoomForCellSize(0.15)).toBe(BASE_ZOOM);
    // z10 cells are ~153 m, coarser than 150, so z11 (~76 m) is chosen.
    expect(zoomForCellSize(150)).toBe(11);
    expect(zoomForCellSize(cellSize(12))).toBe(12);
    expect(zoomForCellSize(0.001)).toBe(BASE_ZOOM);
  });

  it("covers a viewport with the tiles containing it", () => {
    const { x, y } = lngLatToCell(POS[0], POS[1], BASE_ZOOM);
    const { xs, ys } = tileRangeForBbox(
      [POS[0] - 0.0002, POS[1] - 0.0002, POS[0] + 0.0002, POS[1] + 0.0002],
      BASE_ZOOM,
    );
    expect(xs).toContain(x);
    expect(ys).toContain(y);
  });

  it("wraps tile x across the antimeridian", () => {
    const { xs } = tileRangeForBbox([179, -1, -179, 1], 10);
    expect(xs.length).toBeGreaterThan(1);
    expect(xs.some((v) => v > 1000)).toBe(true);
    expect(xs.some((v) => v < 24)).toBe(true);
  });

  it("decodes a served tile into lon/lat depth samples", () => {
    const { x, y, cx, cy } = lngLatToCell(POS[0], POS[1], BASE_ZOOM);
    const cells: TileCells = new Map();
    mergeCell(cells, cy * TILE_SIZE + cx, encodeDepth(7.5));
    const samples = decodeTileSamples(BASE_ZOOM, x, y, encodeTile(cells));
    expect(samples).toHaveLength(1);
    expect(samples[0].depth).toBeCloseTo(7.5, 5);
    const back = lngLatToCell(samples[0].lon, samples[0].lat, BASE_ZOOM);
    expect([back.x, back.y, back.cx, back.cy]).toEqual([x, y, cx, cy]);
  });
});
