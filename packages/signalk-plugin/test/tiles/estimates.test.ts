import { expect, test } from "vitest";
import { createDB } from "../../src/storage.js";
import { createCellStore } from "../../src/tiles/cells.js";
import { cellAt } from "../../src/tiles/geometry.js";
const origin = Date.parse("2025-01-01T00:00Z"),
  hour = 3600000,
  pos = cellAt(-80, 26);
const read = (s: ReturnType<typeof createCellStore>) =>
  s.cells(-80.001, 25.999, -79.999, 26.001)[0];
test("summary tree matches the timestamp-weighted oracle across promotion, replacement and retraction", () => {
  const db = createDB(":memory:"),
    other = createDB(":memory:"),
    a = createCellStore(db),
    b = createCellStore(other);
  const depths = Array.from({ length: 600 }, (_, i) => 5 + Math.sin(i / 7));
  const put = (s: typeof a, i: number, depth: number | undefined) =>
    s.replaceWindow(
      origin + i * hour,
      origin + (i + 1) * hour,
      depth === undefined
        ? []
        : [
            {
              ...pos,
              day: Math.floor((origin + i * hour) / 86400000),
              time: (origin + i * hour) * 1000,
              depth,
            },
          ],
      [],
    );
  try {
    for (let i = 0; i < 600; i++) put(a, i, depths[i]);
    for (let i = 599; i >= 0; i--) put(b, i, depths[i]);
    expect(read(b)).toEqual(read(a));
    const oracle = () => {
      const weights = depths.map((_, i) => 2 ** ((i - 599) / (365 * 24)));
      return (
        depths.reduce((sum, d, i) => sum + d * weights[i], 0) /
        weights.reduce((s, w) => s + w, 0)
      );
    };
    expect(read(a).m).toBeCloseTo(Math.floor(oracle() * 100) / 100, 10);
    depths[257] = 3;
    put(a, 257, 3);
    put(b, 257, 3);
    expect(read(a)).toEqual(read(b));
    expect(read(a).m).toBeCloseTo(Math.floor(oracle() * 100) / 100, 10);
    for (let i = 0; i < 600; i++) put(a, i, undefined);
    expect(read(a)).toBeUndefined();
    expect(db.prepare("SELECT count(*) n FROM cell_moments").get()).toEqual({
      n: 0,
    });
  } finally {
    db.close();
    other.close();
  }
});
test("a single visit needs no duplicate ancestor summaries and half-life changes the estimate", () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  try {
    store.setMeta("config_weight", "365");
    store.replaceWindow(
      origin,
      origin + hour,
      [{ ...pos, day: 1, time: origin * 1000, depth: 4 }],
      [],
    );
    expect(db.prepare("SELECT count(*) n FROM cell_moments").get()).toEqual({
      n: 1,
    });
    const later = origin + 365 * 86400000;
    store.replaceWindow(
      later,
      later + hour,
      [{ ...pos, day: 366, time: later * 1000, depth: 10 }],
      [],
    );
    expect(read(store).m).toBe(8);
  } finally {
    db.close();
  }
});

test("changing half-life reweights retained evidence without History or lost coverage", async () => {
  const { reweightCells } = await import("../../src/tiles/refine.js");
  const db = createDB(":memory:"),
    store = createCellStore(db),
    later = origin + 365 * 86400000;
  try {
    store.setMeta("config_weight", "365");
    store.replaceWindow(
      origin,
      origin + hour,
      [{ ...pos, time: origin * 1000, day: 1, depth: 4 }],
      [],
    );
    store.replaceWindow(
      later,
      later + hour,
      [{ ...pos, time: later * 1000, day: 366, depth: 10 }],
      [],
    );
    expect(read(store).m).toBe(8);
    store.setMeta("config_weight", "730");
    store.setMeta("reweight_pending", "1");
    await reweightCells({ store, signal: new AbortController().signal });
    const expected = (4 * Math.SQRT1_2 + 10) / (1 + Math.SQRT1_2);
    expect(read(store).m).toBe(Math.floor(expected * 100) / 100);
    expect(store.windowDone(origin, origin + hour)).toBe(true);
    expect(db.prepare("SELECT count(*) n FROM cell_passes").get()).toEqual({
      n: 2,
    });
    expect(store.getMeta("reweight_pending")).toBe("");
  } finally {
    db.close();
  }
});

test.each([false, true])(
  "read-only pending estimates match committed hourly weights with tides=%s",
  (tided) => {
    const db = createDB(":memory:");
    const store = createCellStore(db);
    const pass = (h: number, depth: number, offset = 0) => ({
      ...pos,
      depth,
      day: Math.floor((origin + h * hour) / 86400000),
      time: (origin + h * hour + offset) * 1000,
      ...(tided && h % 2 ? { tide: 0.15 } : {}),
    });
    store.addPasses(
      Array.from({ length: 600 }, (_, i) => pass(i, 3 + Math.sin(i / 8))),
    );
    const before = read(store);
    const pending = [pass(10, 5, 1000), pass(10, 7, 2000), pass(601, 8)];
    db.exec("PRAGMA query_only=ON");
    const [preview] = store.previewPasses([...pending, pending[0]]);
    expect(read(store)).toEqual(before);
    db.exec("PRAGMA query_only=OFF");
    store.addPasses(pending);
    expect(preview).toEqual(read(store));
    // The worker may receive its request after those same passes were committed.
    expect(store.previewPasses(pending)).toEqual([]);
    db.close();
  },
);

test("pending estimates retain the published cell until its half-life reweight completes", () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  const p = { ...pos, depth: 3, day: 20000, time: origin * 1000 };
  store.addPasses([p]);
  store.setMeta("config_weight", "30");
  expect(store.previewPasses([{ ...p, time: (origin + hour) * 1000 }])).toEqual(
    [],
  );
  db.close();
});

test("an older pending snapshot does not duplicate a longer committed pass", () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  const p = {
    ...pos,
    depth: 3,
    day: 20000,
    start: origin * 1000,
    time: (origin + 10000) * 1000,
  };
  store.addPasses([{ ...p, time: (origin + 20000) * 1000 }]);
  expect(store.previewPasses([p])).toEqual([]);
  db.close();
});

test("pending-only estimates do not replace legacy published evidence", () => {
  const db = createDB(":memory:"),
    store = createCellStore(db);
  store.addPasses([{ ...pos, depth: 4, day: 20000 }]);
  const before = read(store);
  expect(
    store.previewPasses([
      { ...pos, depth: 9, day: 20001, time: origin * 1000 },
    ]),
  ).toEqual([]);
  expect(read(store)).toEqual(before);
  db.close();
});
