import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDB } from "../../src/storage.js";
import { createCellStore } from "../../src/tiles/cells.js";
import { cellAt, cellRanges, tileFraction } from "../../src/tiles/geometry.js";
import { createKeptTiles, tileReach } from "../../src/tiles/kept.js";
import { createTileService, readTile } from "../../src/tiles/service.js";

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
  const kept = createKeptTiles(db, "high", { maxBytes: 1000 });
  const tile = Buffer.alloc(300, 1);
  for (let x = 0; x < 6; x++) kept.keep(kept.reserve(14, x, 100), tile);
  const left = [0, 1, 2, 3, 4, 5].filter(
    (x) => kept.get(14, x, 100) !== undefined,
  );
  expect(left).toEqual([4, 5]);
  db.close();
});
