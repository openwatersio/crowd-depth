import { expect, test } from "vitest";
import vectors from "../../../grid/tests/portrayal_vectors.json" with { type: "json" };
import { createDB } from "../../src/storage.js";
import {
  addPass,
  cellDepth,
  cellSigma,
  createCellStore,
  OVERVIEW_LEVELS,
} from "../../src/tiles/cells.js";
import { cellAt, cellCenter, columnSteps } from "../../src/tiles/geometry.js";
import { depthLabels } from "../../src/tiles/surface.js";

test("cells are the grid's 2/3″ pixels, widened by latitude band as its are", () => {
  for (const [lat0, k] of vectors.column_steps)
    expect(columnSteps(lat0)).toBe(k);
  // A cell's centre lies in the cell.
  for (const [lon, lat] of [
    [-76.2, 36.98],
    [10.5, 59.9],
    [-122.3, -47.6],
  ]) {
    const c = cellAt(lon, lat);
    const centre = cellCenter(c.py, c.px);
    expect(cellAt(centre.lon, centre.lat)).toEqual(c);
    expect(Math.abs(centre.lat - lat)).toBeLessThan(1 / 5400);
  }
});

test("sounding labels round toward shoal as the grid's", () => {
  for (const [d, labels] of vectors.depths) {
    expect(depthLabels(d as number)).toEqual(labels);
  }
});

test("a cell's estimate is a moving average of its passes, less k σ", () => {
  let cell = addPass(undefined, { py: 0, px: 0, depth: 10, day: 1 });
  expect(cell).toMatchObject({ m: 10, d: 0.3, passes: 1 });
  // One pass: σ is the correction uncertainty and the first deviation.
  expect(cellSigma(cell)).toBeCloseTo(Math.hypot(0.5, 1.0, 0.375), 6);
  expect(cellDepth(cell)).toBeCloseTo(10 - 1.75 * cellSigma(cell), 6);

  // A 1 m shoal shows within two passes and lets go in about twelve.
  for (let i = 0; i < 2; i++)
    cell = addPass(cell, { py: 0, px: 0, depth: 9, day: 2 });
  expect(cell.m).toBeLessThan(9.7);
  for (let i = 0; i < 12; i++)
    cell = addPass(cell, { py: 0, px: 0, depth: 10, day: 3 });
  expect(cell.m).toBeGreaterThan(9.97);
  expect(cell).toMatchObject({ passes: 15, first: 1, last: 3 });
});

test("the margin never makes wet water drying", () => {
  expect(cellDepth({ m: 0.5, d: 0.3 })).toBe(0);
  expect(cellDepth({ m: -0.4, d: 0.3 })).toBeLessThan(-0.4);
});

test("the store keeps one row per cell however many passes", () => {
  const store = createCellStore(createDB(":memory:"));
  const { py, px } = cellAt(-76.2, 36.98);
  for (let i = 0; i < 5; i++)
    store.addPasses([{ py, px, depth: 4 + i * 0.1, day: i }]);
  const cells = store.cells(-76.21, 36.97, -76.19, 36.99);
  expect(cells).toHaveLength(1);
  expect(cells[0].passes).toBe(5);
  // 4.164 unrounded; stored in centimetres each pass.
  expect(cells[0].m).toBeCloseTo(4.164, 1);
});

test("each overview block holds its shoalest cell, also after that cell deepens", () => {
  const store = createCellStore(createDB(":memory:"));
  const a = cellAt(-76.2, 36.98);
  // Cells inside one block at every level.
  const base = { py: a.py & ~63, px: a.px & ~63 };
  const c1 = { py: base.py, px: base.px };
  const c2 = { py: base.py, px: base.px + 1 };
  store.addPasses([
    { ...c1, depth: 3, day: 1 },
    { ...c2, depth: 5, day: 1 },
  ]);
  const shoalest = (level: number) =>
    store.cells(-76.3, 36.9, -76.1, 37.1, level).map((c) => [c.py, c.px]);
  for (const level of OVERVIEW_LEVELS)
    expect(shoalest(level)).toEqual([[c1.py, c1.px]]);
  // c1 deepens past c2: the blocks find c2.
  for (let i = 0; i < 20; i++) store.addPasses([{ ...c1, depth: 9, day: 2 }]);
  for (const level of OVERVIEW_LEVELS)
    expect(shoalest(level)).toEqual([[c2.py, c2.px]]);
});

test("an unconfirmed shoal keeps the shoalest reading in its cell", () => {
  const store = createCellStore(createDB(":memory:"));
  const at = { lon: -76.2, lat: 36.98 };
  store.addShoals([
    { ...at, depth: 2.4, time: 1 },
    { ...at, depth: 1.1, time: 2 },
    { ...at, depth: 3.0, time: 3 },
  ]);
  expect(store.shoals(-76.21, 36.97, -76.19, 36.99)).toEqual([
    { ...at, depth: 1.1, time: 2 },
  ]);
});

test("rebuilt overviews match the ones kept pass by pass", () => {
  const kept = createCellStore(createDB(":memory:"));
  const later = createCellStore(createDB(":memory:"));
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 300; i++) {
    const { py, px } = cellAt(-76.2 + random() * 0.05, 36.98 + random() * 0.05);
    const pass = { py, px, depth: 2 + random() * 10, day: i };
    kept.addPasses([pass]);
    later.addPasses([pass], false);
  }
  later.rebuildOverviews();
  for (const level of OVERVIEW_LEVELS) {
    const key = (c: { py: number; px: number }) => `${c.py},${c.px}`;
    const blocks = (s: typeof kept) =>
      s.cells(-76.3, 36.9, -76.1, 37.1, level).map(key).sort();
    expect(blocks(later)).toEqual(blocks(kept));
  }
});
