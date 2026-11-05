import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDB, hasKeptTiles } from "../../src/storage.js";
import { createCellStore } from "../../src/tiles/cells.js";
import { cellAt, cellRanges, tileFraction } from "../../src/tiles/geometry.js";
import { createKeptTiles, tileReach } from "../../src/tiles/kept.js";
import {
  KEEP_QUIET_MS,
  createTileService,
  readTile,
} from "../../src/tiles/service.js";

const LON = -76.2;
const LAT = 36.98;

const pass = (depth: number, lon = LON) =>
  Array.from({ length: 60 }, (_, i) => ({
    ...cellAt(lon, LAT - 0.005 + i / 5400),
    depth,
    day: 20000,
  }));

const tileAt = (z: number, lon = LON) => {
  const f = tileFraction(lon, LAT, z);
  return [z, Math.floor(f.x), Math.floor(f.y)] as const;
};

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
  file = join(dir, "bathymetry.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a tile built once is read back after a restart", async () => {
  const db = createDB(file);
  const store = createCellStore(db);
  store.addPasses(pass(8));
  const at = tileAt(14);
  const tiles = createTileService(
    store,
    undefined,
    "high",
    createKeptTiles(db, "high"),
  );
  const tile = await tiles.get(...at);
  expect(tile?.length).toBeGreaterThan(0);
  tiles.close();

  const again = createKeptTiles(db, "high");
  expect(again.get(...at)).toEqual(tile);
  // Kept by detail: the other detail's is built afresh.
  expect(createKeptTiles(db, "standard").get(...at)).toBeUndefined();
  // Where the boat has no soundings, kept as empty.
  const empty = createTileService(store, undefined, "high", again);
  expect(await empty.get(...tileAt(14, LON + 1))).toBeUndefined();
  expect(again.get(...tileAt(14, LON + 1))).toBeNull();
  db.close();
});

test("a write under a kept tile drops it, from any connection", () => {
  const db = createDB(file);
  const store = createCellStore(db);
  store.addPasses(pass(8));
  const kept = createKeptTiles(db, "high");
  const keep = (...at: readonly [number, number, number]) => {
    kept.keep(kept.reserve(...at), readTile(store, ...at));
    expect(kept.get(...at)).toBeDefined();
  };
  const z15 = tileAt(15);
  const z10 = tileAt(10);
  const far = tileAt(14, LON + 0.5);
  keep(...z15);
  keep(...z10);
  keep(...far);

  // Written as a build that doesn't know kept tiles would: a cell beside the z15 tile's
  // ancestor, within the surface's margin.
  const other = new (
    db.constructor as typeof import("node:sqlite").DatabaseSync
  )(file);
  const { py, px } = cellAt(LON, LAT);
  other.prepare("UPDATE cells SET m = 300 WHERE py = ? AND px = ?").run(py, px);
  expect(kept.get(...z15)).toBeUndefined();
  expect(kept.get(...z10)).toBeUndefined();
  expect(kept.get(...far)).toBeDefined();

  // A shoal.
  keep(...z15);
  const shoal = cellAt(LON, LAT + 0.001);
  other
    .prepare(
      "INSERT INTO shoals(py, px, lon, lat, depth, time) VALUES(?, ?, ?, ?, 1, 1)",
    )
    .run(shoal.py, shoal.px, LON, LAT + 0.001);
  expect(kept.get(...z15)).toBeUndefined();

  // An overview block holding a cell 10 rows past the tile's box: a block of 64 rows
  // may reach into it, one of 2 can't.
  const r = tileReach(...far);
  const box = cellRanges(r.west, r.south, r.east, r.north).at(-1)!;
  const block = other.prepare(
    `INSERT OR REPLACE INTO overviews(level, oy, ox, py, px, m, d, passes, first, last)
     VALUES(?, 0, 0, ?, ?, 100, 1, 1, 1, 1)`,
  );
  block.run(1, box.py1 + 10, box.px0);
  expect(kept.get(...far)).toBeDefined();
  block.run(6, box.py1 + 10, box.px0);
  expect(kept.get(...far)).toBeUndefined();
  other.close();
  db.close();
});

test("a build that read the cells before a write isn't kept", () => {
  const db = createDB(file);
  const store = createCellStore(db);
  store.addPasses(pass(8));
  const kept = createKeptTiles(db, "high");
  const at = tileAt(14);
  const id = kept.reserve(...at);
  const tile = readTile(store, ...at);
  store.addPasses(pass(20));
  kept.keep(id, tile);
  expect(kept.get(...at)).toBeUndefined();
  db.close();
});

test("tiles drawn by another build are dropped", () => {
  const db = createDB(file);
  const store = createCellStore(db);
  store.addPasses(pass(8));
  const at = tileAt(14);
  const kept = createKeptTiles(db, "high", { version: "a" });
  kept.keep(kept.reserve(...at), readTile(store, ...at));
  expect(
    createKeptTiles(db, "high", { version: "a" }).get(...at),
  ).toBeDefined();
  expect(
    createKeptTiles(db, "high", { version: "b" }).get(...at),
  ).toBeUndefined();
  // A reservation a stopped start left is dropped too.
  const left = createKeptTiles(db, "high", { version: "b" });
  left.reserve(...at);
  createKeptTiles(db, "high", { version: "b" });
  expect(db.prepare("SELECT count(*) AS n FROM kept_tile_boxes").get()).toEqual(
    { n: 0 },
  );
  db.close();
});

test("the oldest kept tiles go first past the bound", () => {
  const db = createDB(file);
  const kept = createKeptTiles(db, "high", { maxBytes: 2000 });
  const tile = Buffer.alloc(300, 1);
  // Each counted with its row, 556 bytes.
  for (let x = 0; x < 6; x++) kept.keep(kept.reserve(14, x, 100), tile);
  const left = [0, 1, 2, 3, 4, 5].filter(
    (x) => kept.get(14, x, 100) !== undefined,
  );
  expect(left).toEqual([3, 4, 5]);
  db.close();
});

test("a tile reserved again leaves none of its old boxes", () => {
  const db = createDB(file);
  const kept = createKeptTiles(db, "high");
  const boxes = () =>
    (
      db.prepare("SELECT count(*) AS n FROM kept_tile_boxes").get() as {
        n: number;
      }
    ).n;
  kept.reserve(...tileAt(8));
  const one = boxes();
  expect(one).toBeGreaterThan(0);
  // As after a build that failed, asked for again.
  kept.reserve(...tileAt(8));
  expect(boxes()).toBe(one);
  // Boxes left without a tile, or with none at all, go on start.
  db.exec(`
    INSERT INTO kept_tile_boxes(id, py0, py1, px0, px1) VALUES(99998, 0, 1, 0, 1);
    INSERT INTO kept_tile_box_owners(box, tile) VALUES(99998, 99999);
    INSERT INTO kept_tile_boxes(id, py0, py1, px0, px1) VALUES(99997, 0, 1, 0, 1);`);
  createKeptTiles(db, "high");
  expect(boxes()).toBe(0);
  db.close();
});

test("empty tiles count toward the bound", () => {
  const db = createDB(file);
  const kept = createKeptTiles(db, "high", { maxBytes: 2000 });
  for (let x = 0; x < 40; x++) kept.keep(kept.reserve(14, x, 100), undefined);
  const left = Array.from({ length: 40 }, (_, x) => kept.get(14, x, 100));
  expect(left.filter((t) => t === null).length).toBeLessThan(10);
  expect(left.at(-1)).toBeNull();
  db.close();
});

test("an overview block whose cell moves away drops the tiles it was under", () => {
  const db = createDB(file);
  const store = createCellStore(db);
  store.addPasses(pass(8));
  const kept = createKeptTiles(db, "high");
  const at = tileAt(14, LON + 0.5);
  const r = tileReach(...at);
  const box = cellRanges(r.west, r.south, r.east, r.north)[0];
  // Written as the cell store writes blocks: an upsert, which updates the row.
  const block = db.prepare(
    `INSERT INTO overviews(level, oy, ox, py, px, m, d, passes, first, last)
     VALUES(4, 1, 1, ?, ?, 100, 1, 1, 1, 1)
     ON CONFLICT(level, oy, ox) DO UPDATE SET py = excluded.py, px = excluded.px`,
  );
  block.run(box.py0, box.px0);
  kept.keep(kept.reserve(...at), readTile(store, ...at));
  expect(kept.get(...at)).toBeDefined();
  block.run(box.py0 + 10_000, box.px0);
  expect(kept.get(...at)).toBeUndefined();
  db.close();
});

test("clearing the cells drops every kept tile, and later writes still do", () => {
  const db = createDB(file);
  const store = createCellStore(db);
  store.addPasses(pass(8));
  const kept = createKeptTiles(db, "high");
  const at = tileAt(14);
  kept.keep(kept.reserve(...at), readTile(store, ...at));
  store.clear();
  expect(kept.get(...at)).toBeUndefined();
  kept.keep(kept.reserve(...at), readTile(store, ...at));
  expect(kept.get(...at)).toBeNull();
  store.addPasses(pass(8));
  expect(kept.get(...at)).toBeUndefined();
  db.close();
});

test("a database from before kept tiles takes them on", () => {
  const db = createDB(file);
  const store = createCellStore(db);
  store.addPasses(pass(8));
  expect(hasKeptTiles(db)).toBe(false);
  db.close();
  const again = createDB(file);
  const kept = createKeptTiles(again, "high");
  const at = tileAt(14);
  const reread = createCellStore(again);
  kept.keep(kept.reserve(...at), readTile(reread, ...at));
  expect(kept.get(...at)?.length).toBeGreaterThan(0);
  reread.addPasses(pass(20));
  expect(kept.get(...at)).toBeUndefined();
  again.close();
});

test("a database that can't keep tiles still writes and clears its cells", () => {
  const db = createDB(file);
  // A view where a table should be: indexing it fails partway through the schema, as a
  // build of SQLite without R*Tree would.
  db.exec("CREATE VIEW kept_tile_box_owners AS SELECT 1 AS box, 1 AS tile");
  expect(() => createKeptTiles(db, "high")).toThrow();
  expect(hasKeptTiles(db)).toBe(false);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all(),
  ).toEqual([]);
  const store = createCellStore(db);
  store.addPasses(pass(8));
  store.clear();
  store.addPasses(pass(8));
  expect(readTile(store, ...tileAt(14)).length).toBeGreaterThan(0);
  db.close();
});

test("tiles built while a backfill writes aren't kept", async () => {
  const db = createDB(file);
  const store = createCellStore(db);
  store.addPasses(pass(8));
  const kept = createKeptTiles(db, "high");
  const tiles = createTileService(store, undefined, "high", kept);
  const at = tileAt(14);
  tiles.share(false);
  expect((await tiles.get(...at))?.length).toBeGreaterThan(0);
  expect(kept.get(...at)).toBeUndefined();
  tiles.share(true);
  tiles.reset();
  await tiles.get(...at);
  expect(kept.get(...at)?.length).toBeGreaterThan(0);
  tiles.close();
  db.close();
});

test("rebuilding the overviews keeps the tiles whose blocks stay the same", () => {
  const db = createDB(file);
  const store = createCellStore(db);
  // Each cell a depth of its own, so each block's shoalest is one cell, picked alike by
  // the live writer and the rebuild.
  store.addPasses(pass(8).map((p, i) => ({ ...p, depth: 8 + i / 10 })));
  const kept = createKeptTiles(db, "high");
  const at = tileAt(12);
  kept.keep(kept.reserve(...at), readTile(store, ...at));
  // As every backfill ends, however few soundings it found.
  store.rebuildOverviews();
  expect(kept.get(...at)?.length).toBeGreaterThan(0);
  db.close();
});

test("a tile changed in the last few minutes isn't kept", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const db = createDB(file);
    const store = createCellStore(db);
    store.addPasses(pass(8));
    const kept = createKeptTiles(db, "high");
    const tiles = createTileService(store, undefined, "high", kept);
    const at = tileAt(14);
    tiles.changed([{ lon: LON, lat: LAT }]);
    await tiles.get(...at);
    expect(kept.get(...at)).toBeUndefined();
    vi.setSystemTime(Date.now() + KEEP_QUIET_MS);
    tiles.reset();
    await tiles.get(...at);
    expect(kept.get(...at)?.length).toBeGreaterThan(0);
    tiles.close();
    db.close();
  } finally {
    vi.useRealTimers();
  }
});

test("dropping a kept tile finds its boxes by index, not by scanning them", () => {
  const db = createDB(file);
  createKeptTiles(db, "high");
  const plan = (sql: string) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
      (r) => r.detail,
    );
  // INDEX 1 is the R*Tree's lookup by id; INDEX 2 with no constraints reads it whole.
  expect(
    plan(
      "DELETE FROM kept_tile_boxes WHERE id IN (SELECT box FROM kept_tile_box_owners WHERE tile = 1)",
    ),
  ).toContain("SCAN kept_tile_boxes VIRTUAL TABLE INDEX 1:");
  db.close();
});
