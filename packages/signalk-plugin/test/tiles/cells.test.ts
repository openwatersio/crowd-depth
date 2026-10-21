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

test("a rebuild replaces a shoaler pick whose cell has since deepened", () => {
  const db = createDB(":memory:");
  const store = createCellStore(db);
  // Two cells in one block at every level.
  const at = cellAt(-76.2, 36.98);
  const a = { py: at.py, px: at.px - (at.px & 63) };
  const b = { py: at.py, px: a.px + 1 };
  store.addPasses([{ ...a, depth: 2, day: 1 }]);
  store.addPasses([{ ...b, depth: 5, day: 1 }]);
  // The cell deepens without its blocks hearing of it, as a stopped backfill leaves it.
  db.prepare("UPDATE cells SET m = 900 WHERE py = ? AND px = ?").run(
    a.py,
    a.px,
  );
  store.rebuildOverviews();
  for (const level of OVERVIEW_LEVELS) {
    const [pick] = store.cells(-76.21, 36.97, -76.19, 36.99, level);
    expect([pick.py, pick.px]).toEqual([b.py, b.px]);
  }
});

/** A store whose overview rebuild runs `live` just after it reads its first stretch of
 * cells, as the live writer can on another connection. */
function racing(live: (store: ReturnType<typeof createCellStore>) => void) {
  const db = createDB(":memory:");
  const store = createCellStore(db);
  let hook: (() => void) | undefined = () => live(store);
  const wrapped = new Proxy(db, {
    get(target, p) {
      if (p === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("FROM cells WHERE py BETWEEN")) return stmt;
          return {
            all: (...args: number[]) => {
              const rows = stmt.all(...args);
              hook?.();
              hook = undefined;
              return rows;
            },
          };
        };
      }
      const v = Reflect.get(target, p);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { store, db, rebuilding: createCellStore(wrapped) };
}

test("a rebuild keeps the overview picks the live writer makes while it runs", () => {
  const at = cellAt(-76.2, 36.98);
  // Two cells in one block at every level.
  const [a, b] = [0, 1].map((i) => ({
    py: at.py,
    px: at.px - (at.px & 63) + i,
  }));
  const pick = (s: ReturnType<typeof createCellStore>) =>
    OVERVIEW_LEVELS.map((level) => {
      const [p] = s.cells(-76.21, 36.97, -76.19, 36.99, level);
      return p.px;
    });

  // A shoaler cell arrives after the rebuild read the stretch.
  const shoaler = racing((s) => s.addPasses([{ ...b, depth: 1, day: 2 }]));
  shoaler.store.addPasses([{ ...a, depth: 5, day: 1 }]);
  shoaler.rebuilding.rebuildOverviews();
  expect(pick(shoaler.store)).toEqual(OVERVIEW_LEVELS.map(() => b.px));

  // The cell the rebuild picked deepens after it read it, and the writer re-picks.
  // A deep pass widens a cell's spread, so a little deeper is what deepens it: a goes
  // from about 6 cm shoaler than b to 5 cm deeper.
  const deeper = racing((s) => s.addPasses([{ ...a, depth: 3, day: 2 }]));
  deeper.store.addPasses([{ ...a, depth: 2, day: 1 }]);
  deeper.store.addPasses([{ ...b, depth: 2.03, day: 1 }]);
  deeper.rebuilding.rebuildOverviews();
  expect(pick(deeper.store)).toEqual(OVERVIEW_LEVELS.map(() => b.px));
});

test("a rebuild searches a block again when the cell it picked changes under it", () => {
  const at = cellAt(-76.2, 36.98);
  // In one row, three cells share a block from level 2 up.
  const [a, b, x] = [0, 1, 2].map((i) => ({
    py: at.py,
    px: at.px - (at.px & 63) + i,
  }));
  // Deepened a little after the rebuild read it, a is no longer the shoalest.
  const { store, rebuilding } = racing((s) =>
    s.addPasses([{ ...a, depth: 3, day: 2 }]),
  );
  store.addPasses([{ ...x, depth: 10, day: 1 }]);
  // A backfill's cells, not yet in the overviews.
  store.addPasses([{ ...a, depth: 2, day: 1 }], false);
  store.addPasses([{ ...b, depth: 2.03, day: 1 }], false);
  rebuilding.rebuildOverviews();
  for (const level of OVERVIEW_LEVELS.filter((l) => l >= 2)) {
    const [pick] = store.cells(-76.21, 36.97, -76.19, 36.99, level);
    expect(pick.px).toBe(b.px);
  }
});

test("a rebuild over a stale block row keeps a cell the live writer added meanwhile", () => {
  const at = cellAt(-76.2, 36.98);
  const [s, p, x] = [0, 1, 2].map((i) => ({
    py: at.py,
    px: at.px - (at.px & 63) + i,
  }));
  const { store, rebuilding, db } = racing((live) =>
    live.addPasses([{ ...x, depth: 5, day: 2 }]),
  );
  store.addPasses([{ ...s, depth: 3, day: 1 }]);
  // A backfill deepened s, and added p, without the overviews hearing of it.
  db.prepare("UPDATE cells SET m = 1000 WHERE py = ? AND px = ?").run(
    s.py,
    s.px,
  );
  store.addPasses([{ ...p, depth: 8, day: 1 }], false);
  rebuilding.rebuildOverviews();
  for (const level of OVERVIEW_LEVELS.filter((l) => l >= 2)) {
    const [pick] = store.cells(-76.21, 36.97, -76.19, 36.99, level);
    expect(pick.px).toBe(x.px);
  }
});
