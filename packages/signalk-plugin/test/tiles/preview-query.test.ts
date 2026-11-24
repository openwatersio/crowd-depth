import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDB } from "../../src/storage.js";
import { createCellStore } from "../../src/tiles/cells.js";
import { createPreviewStore } from "../../src/tiles/history-preview.js";
import { cellAt, cellCenter } from "../../src/tiles/geometry.js";

const view = [14, -81, 25, -79, 27] as const;
const time = Date.parse("2026-10-16T12:00:00Z");
const start = cellAt(-80.9, 26);
const point = (px: number, py = start.py, timestamp = time) => ({
  ...cellCenter(py, px),
  depth: 6,
  time: timestamp,
});

test("refined evidence is excluded before the viewport limit", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  store.write(
    "history",
    Array.from({ length: 5000 }, (_, i) => point(start.px + i)),
  );
  db.prepare("INSERT INTO refined_windows VALUES(?,?)").run(time, time + 1);
  store.write("history", [point(start.px + 5000, start.py, time - 1)]);
  expect(store.features(view, 0).map((f) => f.properties.time)).toEqual([
    time - 1,
  ]);
  db.prepare("INSERT INTO refined_windows VALUES(?,?)").run(time - 1, time);
  expect(store.features(view, 0)).toEqual([]);
  db.prepare("DELETE FROM refined_windows WHERE start=?").run(time - 1);
  expect(store.features(view, 0).map((f) => f.properties.time)).toEqual([
    time - 1,
  ]);
  db.close();
});

test("a sparse wide viewport does not need repeated polls to cross distant tracks", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  store.write(
    "history",
    Array.from({ length: 20000 }, (_, i) => ({
      ...point(start.px, start.py - 10000 + i),
      lon: 0,
    })),
  );
  const target = { lon: -80, lat: 25.01, depth: 5, time };
  store.write("history", [target]);
  expect(store.features(view, 0)).toHaveLength(1);
  for (let i = 0; i < 30; i++) {
    const jitter = (i % 2 ? 1 : -1) * 0.000001;
    const got = store.features(
      [14, -81 + jitter, 25 + jitter, -79 + jitter, 27 + jitter],
      0,
    );
    expect(got.map((f) => f.geometry.coordinates)).toEqual([
      [target.lon, target.lat],
    ]);
  }
  db.close();
});

test("many plotters and zoom levels have independent complete spatial lookups", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  for (let i = 0; i < 20; i++)
    store.write("history", [{ lon: -80 + i * 5, lat: 26, depth: 5, time }]);
  for (let round = 0; round < 3; round++)
    for (let i = 0; i < 20; i++) {
      expect(
        store.features([12 + round, -81 + i * 5, 25, -79 + i * 5, 27], 0),
      ).toHaveLength(1);
    }
  db.close();
});

test("nearby clients do not evict each other's edge evidence", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  store.write("history", [
    { lon: -80, lat: 26, depth: 5, time },
    { lon: -81.1, lat: 26, depth: 5, time },
  ]);
  for (let i = 0; i < 10; i++) {
    expect(store.features(view, 0)).toHaveLength(1);
    expect(store.features([14, -81.15, 24.85, -78.85, 27.15], 0)).toHaveLength(
      2,
    );
  }
  db.close();
});

test("a full quiet viewport stays stable and deep evidence cannot evict it", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  store.write(
    "history",
    Array.from({ length: 3000 }, (_, i) => point(start.px + i)),
  );
  const got = store.features(view, 0);
  expect(got).toHaveLength(1200);
  for (let i = 0; i < 10; i++) expect(store.features(view, 0)).toEqual(got);
  store.write(
    "history",
    Array.from({ length: 2400 }, (_, i) => ({
      ...point(start.px + i + 3000, start.py, time + 1),
      depth: 250,
    })),
  );
  expect(store.features(view, 0)).toHaveLength(1200);
  expect(store.features(view, 0).every((f) => f.properties.time === time)).toBe(
    true,
  );
  db.close();
});

test("latest writes, refinement receipts and paired history replacement update the index atomically", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  store.write("local", [point(start.px)]);
  db.prepare("INSERT INTO refined_windows VALUES(?,?)").run(time, time + 1000);
  expect(store.features(view, 0)).toEqual([]);
  store.write("local", [point(start.px, start.py, time + 1000)]);
  expect(store.features(view, 0)[0].properties.time).toBe(time + 1000);
  store.write("history", [], [time + 1000, time + 1001]);
  expect(store.features(view, 0)).toEqual([]);
  store.write("history", [point(start.px, start.py, time + 1000)]);
  store.write("local", [point(start.px, start.py, time - 1)]);
  expect(store.features(view, 0)[0].properties.time).toBe(time + 1000);
  expect(store.features(view, time + 1001)).toEqual([]);
  db.close();
});

test("clearing QC exposes retained previews without rewriting the index", () => {
  const db = createDB(":memory:"),
    cells = createCellStore(db),
    store = createPreviewStore(db, "a");
  store.write("history", [
    point(start.px),
    { ...point(start.px + 1), depth: 250 },
  ]);
  db.prepare("INSERT INTO refined_windows VALUES(?,?)").run(time, time + 1);
  expect(store.features(view, 0)).toEqual([]);
  const before = db.prepare("SELECT * FROM preview_spatial ORDER BY id").all();
  cells.clear();
  expect(db.prepare("SELECT * FROM preview_spatial ORDER BY id").all()).toEqual(
    before,
  );
  expect(store.features(view, 0)).toHaveLength(1);
  db.prepare("INSERT INTO refined_windows VALUES(?,?)").run(time, time + 1);
  expect(store.features(view, 0)).toEqual([]);
  db.close();
});

test("dateline and latitude bands retain distinct cell identities", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  const points = [59.9999, 60.0001, -60.0001].flatMap((lat) =>
    [179.99, -179.99].map((lon) => ({ lat, lon, depth: 6, time })),
  );
  store.write("history", points);
  expect(store.features([10, 179, 59, -179, 61], 0)).toHaveLength(4);
  expect(store.features([10, 179, -61, -179, -59], 0)).toHaveLength(2);
  expect(db.prepare("SELECT count(*) AS n FROM preview_spatial").get()?.n).toBe(
    6,
  );
  db.close();
});

test.each([undefined, "broken", "{}", "[1e30,0]"])(
  "legacy migration recovers a disposable cursor (%s)",
  async (cursor) => {
    const db = createDB(":memory:"),
      before = createPreviewStore(db, "a");
    before.write(
      "history",
      Array.from({ length: 1201 }, (_, i) =>
        point(start.px + i, start.py, time + i),
      ),
    );
    db.prepare("INSERT INTO refined_windows VALUES(?,?)").run(
      time,
      time + 1000,
    );
    db.exec(
      "DROP TABLE preview_spatial; CREATE INDEX preview_lat ON preview_cells(lat,lon)",
    );
    const after = createPreviewStore(db, "a");
    if (cursor)
      db.prepare(
        "INSERT OR REPLACE INTO preview_meta VALUES('spatial_cursor',?)",
      ).run(cursor);
    expect(before.features(view, 0)).toEqual([]);
    expect(after.features(view, 0)).toEqual([]);
    await after.prepare();
    expect(after.features(view, 0)).toHaveLength(201);
    expect(db.prepare("SELECT count(*) AS n FROM preview_cells").get()?.n).toBe(
      1201,
    );
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='preview_lat'").get(),
    ).toBeUndefined();
    db.close();
  },
);

test("stationary preview batches update once per cell and identical replays do not write", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  const changes = () =>
    Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  const samples = Array.from({ length: 1000 }, (_, i) =>
    point(start.px, start.py, time + i),
  );
  const before = changes();
  store.write("history", samples);
  expect(changes() - before).toBeLessThan(30);
  expect(store.features(view, 0)[0].properties.time).toBe(time + 999);
  const written = changes();
  store.write("history", samples);
  expect(changes()).toBe(written);
  db.close();
});

test("configuration invalidation drops the derived tree in bulk and remains transactional", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  store.write(
    "history",
    Array.from({ length: 2000 }, (_, i) => point(start.px + i)),
  );
  const before = store.features(view, 0);
  db.exec(
    "CREATE TRIGGER fail_config BEFORE INSERT ON preview_meta WHEN new.key='config' BEGIN SELECT RAISE(ABORT,'fail config'); END",
  );
  expect(() => createPreviewStore(db, "b")).toThrow("fail config");
  expect(store.features(view, 0)).toEqual(before);
  db.exec("DROP TRIGGER fail_config");
  const changes = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  const next = createPreviewStore(db, "b");
  // Canonical rows are deleted, but no per-cell virtual-table updates run.
  expect(
    Number(db.prepare("SELECT total_changes() AS n").get()!.n) - changes,
  ).toBeLessThan(2100);
  expect(next.features(view, 0)).toEqual([]);
  next.write("history", [point(start.px)]);
  expect(next.features(view, 0)).toHaveLength(1);
  db.close();
});

test("overlapping receipts mark inserts, replacements and migrated evidence consistently", async () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  store.write("history", [point(start.px, start.py, time + 7)]);
  db.prepare("INSERT INTO refined_windows VALUES(?,?)").run(time, time + 10);
  db.prepare("INSERT INTO refined_windows VALUES(?,?)").run(time + 5, time + 6);
  store.write("history", [point(start.px + 1, start.py, time + 7)]);
  expect(store.features(view, 0)).toEqual([]);
  db.prepare("DELETE FROM refined_windows WHERE start=?").run(time + 5);
  expect(store.features(view, 0)).toEqual([]);
  db.prepare("INSERT INTO refined_windows VALUES(?,?)").run(time + 5, time + 6);
  // A derived-schema upgrade retains evidence and rebuilds the index and triggers.
  db.exec(
    "UPDATE preview_meta SET value='obsolete' WHERE key='spatial_version'",
  );
  const next = createPreviewStore(db, "a");
  await next.prepare();
  expect(next.features(view, 0)).toEqual([]);
  expect(db.prepare("SELECT count(*) n FROM preview_cells").get()?.n).toBe(2);
  db.prepare("DELETE FROM refined_windows WHERE start=?").run(time);
  expect(next.features(view, 0)).toHaveLength(2);
  db.close();
});

test("replaying an unchanged receipt does not rewrite every retired point", () => {
  const db = createDB(":memory:"),
    cells = createCellStore(db),
    store = createPreviewStore(db, "a");
  store.write(
    "history",
    Array.from({ length: 3000 }, (_, i) => point(start.px + i)),
  );
  cells.replaceWindow(time, time + 1000, [], []);
  const before = Number(db.prepare("SELECT total_changes() n").get()!.n);
  cells.replaceWindow(time, time + 1000, [], []);
  expect(
    Number(db.prepare("SELECT total_changes() n").get()!.n) - before,
  ).toBeLessThan(10);
  expect(store.features(view, 0)).toEqual([]);
  cells.replaceWindow(time, time + 1, [], []);
  expect(store.features(view, 0)).toEqual([]);
  db.close();
});

test("recent tracks remain visible when thousands of older points fill the view", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  store.write(
    "history",
    Array.from({ length: 5000 }, (_, i) => point(start.px + i)),
  );
  store.write("history", [
    point(start.px + 6000, start.py, time + 2 * 86400_000),
  ]);
  const visible = store.features(view, 0);
  expect(visible).toHaveLength(1200);
  expect(visible[0].properties.time).toBe(time + 2 * 86400_000);
  expect(new Set(visible.map((f) => f.id)).size).toBe(1200);
  db.close();
});

test("a full sample includes separate track segments across the viewport", () => {
  const db = createDB(":memory:"),
    store = createPreviewStore(db, "a");
  for (const [lon, lat] of [
    [-80.8, 25.2],
    [-79.3, 25.2],
    [-80.8, 26.7],
    [-79.3, 26.7],
  ]) {
    const origin = cellAt(lon, lat);
    store.write(
      "history",
      Array.from({ length: 1000 }, (_, i) =>
        point(origin.px + (i % 30), origin.py + Math.floor(i / 30)),
      ),
    );
  }
  const visible = store.features(view, 0);
  expect(visible).toHaveLength(1200);
  for (const [lon, lat] of [
    [-80.8, 25.2],
    [-79.3, 25.2],
    [-80.8, 26.7],
    [-79.3, 26.7],
  ])
    expect(
      visible.filter(
        (p) =>
          Math.abs(p.geometry.coordinates[0] - lon) < 0.1 &&
          Math.abs(p.geometry.coordinates[1] - lat) < 0.1,
      ).length,
    ).toBeGreaterThanOrEqual(75);
  db.close();
});

test.each([false, true])(
  "SQLite without RTree recovers retained preview (existing=%s)",
  async (existing) => {
    const db = createDB(":memory:"),
      cells = createCellStore(db);
    if (existing) await createPreviewStore(db, "a").close();
    const exec = db.exec.bind(db);
    const prepare = db.prepare.bind(db);
    const mocked = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (!existing && sql.includes("USING rtree_i32"))
        throw new Error("no such module: rtree_i32");
      return exec(sql);
    });
    const mockedPrepare = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (existing && sql === "SELECT 1 FROM preview_spatial LIMIT 1")
        throw new Error("no such module: rtree_i32");
      return prepare(sql);
    });
    try {
      const store = createPreviewStore(db, "a");
      expect(store.spatial).toBe(false);
      await store.prepare();
      store.write("history", [point(start.px)]);
      cells.replaceWindow(time, time + 1, [], []);
      expect(store.features(view, 0)).toEqual([]);
      expect(db.prepare("SELECT count(*) n FROM preview_cells").get()?.n).toBe(
        1,
      );
      mocked.mockRestore();
      mockedPrepare.mockRestore();
      const recovered = createPreviewStore(db, "a");
      await recovered.prepare();
      expect(recovered.spatial).toBe(true);
      expect(recovered.features(view, 0)).toEqual([]);
      recovered.write("history", [point(start.px, start.py, time + 1)]);
      expect(recovered.features(view, 0)).toHaveLength(1);
    } finally {
      mocked.mockRestore();
      mockedPrepare.mockRestore();
      db.close();
    }
  },
);

test.each([267, 11])(
  "a damaged preview RTree cannot disable recording or refinement on restart (code %s)",
  async (code) => {
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-damaged-preview-"));
    const file = join(dir, "test.sqlite");
    let db = createDB(file);
    try {
      const initial = createPreviewStore(db, "a");
      initial.write("history", [point(start.px)]);
      await initial.close();
      // Deliberately damage only this disposable fixture's virtual-table storage.
      db.enableDefensive?.(false);
      db.exec("UPDATE preview_spatial_node SET data=x'00' WHERE nodeno=1");
      db.close();
      db = createDB(file);
      const prepare = db.prepare.bind(db);
      let translated = 0;
      const mocked = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        try {
          return prepare(sql);
        } catch (error) {
          if ((error as { errcode?: number }).errcode !== 267) throw error;
          translated++;
          throw Object.assign(new Error(String(error)), { errcode: code });
        }
      });
      const store = createPreviewStore(db, "a");
      mocked.mockRestore();
      expect(translated).toBeGreaterThan(0);
      expect(store.spatial).toBe(false);
      expect(store.unavailable).toMatch(/RTree|malformed/);
      store.write("history", [point(start.px + 1)]);
      createCellStore(db).replaceWindow(time, time + 1, [], []);
      expect(db.prepare("SELECT count(*) n FROM preview_cells").get()?.n).toBe(
        2,
      );
      expect(
        db.prepare("SELECT count(*) n FROM refined_windows").get()?.n,
      ).toBe(1);
      expect(store.features(view, 0)).toEqual([]);
      await store.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each([11, 267])(
  "preview read damage (%s) leaves the rest of the live response available",
  (errcode) => {
    const db = createDB(":memory:");
    const prepare = db.prepare.bind(db);
    let reads = 0;
    const mocked = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("JOIN preview_cells p"))
        vi.spyOn(statement, "all").mockImplementation(() => {
          reads++;
          throw Object.assign(new Error("damaged preview"), { errcode });
        });
      return statement;
    });
    try {
      const store = createPreviewStore(db, "a");
      store.write("history", [point(start.px)]);
      expect(store.features(view, 0)).toEqual([]);
      expect(store.features(view, 0)).toEqual([]);
      expect(reads).toBe(1);
      expect(store.unavailable).toContain("damaged preview");
    } finally {
      mocked.mockRestore();
      db.close();
    }
  },
);
