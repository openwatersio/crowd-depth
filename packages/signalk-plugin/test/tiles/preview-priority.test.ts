import { expect, test } from "vitest";
import { createDB } from "../../src/storage.js";
import { createCellStore } from "../../src/tiles/cells.js";
import { createPreviewStore } from "../../src/tiles/history-preview.js";
import { previewPriority } from "../../src/tiles/preview-priority.js";
import { createPreviewSpatial } from "../../src/tiles/preview-spatial.js";
import { cellCenter } from "../../src/tiles/geometry.js";

const point = (py: number, px: number) => ({
  ...cellCenter(py, px),
  depth: 4,
  time: 1000,
});

test("migration indexes the viewport centre first without moving its complete sweep cursor", () => {
  const db = createDB(":memory:");
  createCellStore(db);
  const store = createPreviewStore(db, "a");
  store.write(
    "history",
    Array.from({ length: 2001 }, (_, i) => point(i - 1000, 0)),
  );
  db.exec(
    "DROP TABLE preview_spatial; DELETE FROM preview_meta WHERE key='spatial_ready'",
  );
  const spatial = createPreviewSpatial(db);
  const generation = String(
    db.prepare("SELECT value FROM preview_meta WHERE key='generation'").get()!
      .value,
  );
  const view = [13, -1, -1, 1, 1] as const;
  const priority = previewPriority(db, [...view]);
  const first = priority.next();
  expect(first).toHaveLength(32);
  expect(Math.max(...first.map((p) => Math.abs(p.py)))).toBeLessThanOrEqual(16);
  spatial.prioritize(generation, first);
  expect(store.features([...view], 0)).toHaveLength(32);
  expect(
    db
      .prepare("SELECT value FROM preview_meta WHERE key='spatial_cursor'")
      .get(),
  ).toBeUndefined();
  while (!spatial.fill(generation)) {}
  expect(db.prepare("SELECT count(*) n FROM preview_spatial").get()?.n).toBe(
    2001,
  );
  db.close();
});

test("a dense viewport row pages without dropping or repeating cells", () => {
  const db = createDB(":memory:");
  createCellStore(db);
  const store = createPreviewStore(db, "a");
  store.write(
    "history",
    Array.from({ length: 1200 }, (_, i) => point(0, i - 600)),
  );
  const priority = previewPriority(db, [13, -1, -1, 1, 1]);
  const pages = [priority.next(), priority.next(), priority.next()];
  expect(pages.map((p) => p.length)).toEqual([500, 500, 200]);
  expect(new Set(pages.flat().map((p) => `${p.py}/${p.px}`)).size).toBe(1200);
  expect(priority.done).toBe(true);
  db.close();
});

test("empty longitude ranges yield after bounded row seeks", () => {
  const db = createDB(":memory:");
  createCellStore(db);
  const store = createPreviewStore(db, "a");
  store.write(
    "history",
    Array.from({ length: 1000 }, (_, i) => point(i - 500, 0)),
  );
  const priority = previewPriority(db, [13, 10, -1, 11, 1]);
  expect(priority.next()).toEqual([]);
  expect(priority.done).toBe(false);
  for (let i = 0; i < 32 && !priority.done; i++)
    expect(priority.next()).toEqual([]);
  expect(priority.done).toBe(true);
  const dateline = previewPriority(db, [13, 179, -1, -179, 1]);
  store.write("history", [
    { lon: 179.99, lat: 0, depth: 4, time: 1000 },
    { lon: -179.99, lat: 0, depth: 4, time: 1000 },
  ]);
  expect(dateline.next()).toHaveLength(2);
  db.close();
});
