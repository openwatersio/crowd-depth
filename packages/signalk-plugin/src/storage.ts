import { DatabaseSync } from "node:sqlite";

export function createDB(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL");
  // Skip per-commit fsync so 1Hz depth inserts don't wear out SD cards (#100).
  // WAL + NORMAL is durable against corruption; worst case loses recent rows on power loss.
  db.exec("PRAGMA synchronous = NORMAL");
  // The chart's backfill writes from a worker thread on a connection of its own, in
  // short transactions; this connection waits for one rather than failing.
  db.exec("PRAGMA busy_timeout = 5000");

  runMigrations(db, [
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bathymetry(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          longitude REAL NOT NULL,
          latitude REAL NOT NULL,
          depth REAL NOT NULL,
          timestamp INTEGER NOT NULL,
          heading REAL
        );

        CREATE INDEX IF NOT EXISTS idx_bathymetry_timestamp ON bathymetry(timestamp);
      `);
    },
    () => {
      db.exec(`
        CREATE TABLE reports (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "fromTimestamp" INTEGER NOT NULL,
          "toTimestamp" INTEGER NOT NULL
        );
      `);
    },
    () => {
      // A tile pyramid that preview builds of the chart layer kept; the next migration
      // replaces it.
      db.exec(`
        CREATE TABLE tiles(
          z INTEGER NOT NULL,
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          cells BLOB NOT NULL,
          updated INTEGER NOT NULL,
          PRIMARY KEY(z, x, y)
        );

        CREATE TABLE tile_meta(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
    () => {
      // The chart layer's cells, their overviews and its unconfirmed shoals, derived
      // from the soundings above; see tiles/cells.ts. The previews' tiles and markers
      // go, so the cells are built afresh.
      db.exec(`
        DROP TABLE tiles;
        DELETE FROM tile_meta;

        CREATE TABLE cells(
          py INTEGER NOT NULL,
          px INTEGER NOT NULL,
          m INTEGER NOT NULL,
          d INTEGER NOT NULL,
          passes INTEGER NOT NULL,
          first INTEGER NOT NULL,
          last INTEGER NOT NULL,
          PRIMARY KEY(py, px)
        ) WITHOUT ROWID;

        CREATE TABLE overviews(
          level INTEGER NOT NULL,
          oy INTEGER NOT NULL,
          ox INTEGER NOT NULL,
          py INTEGER NOT NULL,
          px INTEGER NOT NULL,
          m INTEGER NOT NULL,
          d INTEGER NOT NULL,
          passes INTEGER NOT NULL,
          first INTEGER NOT NULL,
          last INTEGER NOT NULL,
          PRIMARY KEY(level, oy, ox)
        ) WITHOUT ROWID;

        CREATE TABLE shoals(
          lon REAL NOT NULL,
          lat REAL NOT NULL,
          depth REAL NOT NULL,
          time INTEGER NOT NULL,
          PRIMARY KEY(time, lon, lat)
        ) WITHOUT ROWID;
        CREATE INDEX shoals_lat ON shoals(lat);
      `);
    },
    () => {
      // Unconfirmed shoals, the shoalest per cell, so the table is bounded by the water
      // the boat covered, as the cells are. The rows before it are rebuilt with the cells.
      db.exec(`
        DROP TABLE shoals;
        CREATE TABLE shoals(
          py INTEGER NOT NULL,
          px INTEGER NOT NULL,
          lon REAL NOT NULL,
          lat REAL NOT NULL,
          depth REAL NOT NULL,
          time INTEGER NOT NULL,
          PRIMARY KEY(py, px)
        ) WITHOUT ROWID;
      `);
    },
    () => {
      // Each cell's tide σ, in centimetres, NULL where it's untided, and whether an
      // overview block holds an untided cell; see tiles/cells.ts.
      db.exec(`
        ALTER TABLE cells ADD COLUMN t INTEGER;
        ALTER TABLE overviews ADD COLUMN t INTEGER;
        ALTER TABLE overviews ADD COLUMN u INTEGER;
      `);
    },
    () => {
      // An index on position the first migration once made: nothing reads the log by
      // position, and it took a third of the file.
      db.exec("DROP INDEX IF EXISTS idx_bathymetry_location");
    },
    () => {
      // Once the kept tiles' tables, made since by keptTileSchema, outside the
      // migrations: they're optional, and a build that can't make them must still start.
    },
  ]);

  return db;
}

/**
 * Make the chart layer's kept tiles' tables and triggers (tiles/kept.ts), all or none:
 * a database where they can't be made, such as one without R*Tree, is left as it was.
 * A tile's boxes are the cells, overview blocks and shoals it was built from, one per
 * 1° band, whose columns are its own. The triggers drop a tile whenever a row under one
 * of its boxes changes, whichever build of the plugin writes it, so a kept tile never
 * outlives what it was built from, even after a rollback to a build that doesn't know
 * about them.
 */
export function keptTileSchema(db: DatabaseSync) {
  db.exec("SAVEPOINT kept_tile_schema");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kept_tiles(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        z INTEGER NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        detail TEXT NOT NULL,
        tile BLOB,
        UNIQUE(z, x, y, detail)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS kept_tile_boxes USING rtree_i32(id, py0, py1, px0, px1);
      -- Each box's tile, indexed: an R*Tree can't index a column of its own but by id.
      CREATE TABLE IF NOT EXISTS kept_tile_box_owners(
        box INTEGER PRIMARY KEY,
        tile INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kept_tile_box_owners_tile
        ON kept_tile_box_owners(tile);
      CREATE TRIGGER IF NOT EXISTS kept_tiles_drop AFTER DELETE ON kept_tiles BEGIN
        DELETE FROM kept_tile_boxes WHERE id IN (
          SELECT box FROM kept_tile_box_owners WHERE tile = OLD.id);
        DELETE FROM kept_tile_box_owners WHERE tile = OLD.id;
      END;
    `);
    keptTileTriggers(db, true);
    db.exec("RELEASE kept_tile_schema");
  } catch (err) {
    db.exec("ROLLBACK TO kept_tile_schema; RELEASE kept_tile_schema");
    throw err;
  }
}

/** Whether the database has the kept tiles' tables, made by keptTileSchema. */
export function hasKeptTiles(db: DatabaseSync) {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kept_tiles'",
    )
    .get();
}

const KEPT_TILE_SOURCES = [
  // An overview block reaches 2^level cells from the cell it holds.
  ["cells", "0"],
  ["shoals", "0"],
  ["overviews", "(1 << {}.level)"],
] as const;

/**
 * Make, with `on`, or drop the triggers that drop a kept tile (tiles/kept.ts) when a row
 * it was built from is written. Dropped only for a moment, in a transaction, to clear
 * the tables they're on at once: with them, SQLite deletes row by row. Made only where
 * the kept tiles' tables are: without them, every write the triggers fire on fails.
 */
export function keptTileTriggers(db: DatabaseSync, on: boolean) {
  const under = (row: string, reach: string) => `
    DELETE FROM kept_tiles WHERE id IN (
      SELECT o.tile FROM kept_tile_boxes b JOIN kept_tile_box_owners o ON o.box = b.id
      WHERE b.py0 <= ${row}.py + ${reach} AND b.py1 >= ${row}.py - ${reach}
        AND b.px0 <= ${row}.px + ${reach} AND b.px1 >= ${row}.px - ${reach});`;
  for (const [table, reach] of KEPT_TILE_SOURCES) {
    const r = (row: string) => reach.replace("{}", row);
    db.exec(
      on
        ? `
      CREATE TRIGGER IF NOT EXISTS kept_tiles_${table}_insert AFTER INSERT ON ${table} BEGIN
        ${under("NEW", r("NEW"))}
      END;
      CREATE TRIGGER IF NOT EXISTS kept_tiles_${table}_update AFTER UPDATE ON ${table} BEGIN
        ${under("OLD", r("OLD"))}
        ${under("NEW", r("NEW"))}
      END;
      CREATE TRIGGER IF NOT EXISTS kept_tiles_${table}_delete AFTER DELETE ON ${table} BEGIN
        ${under("OLD", r("OLD"))}
      END;`
        : `
      DROP TRIGGER IF EXISTS kept_tiles_${table}_insert;
      DROP TRIGGER IF EXISTS kept_tiles_${table}_update;
      DROP TRIGGER IF EXISTS kept_tiles_${table}_delete;`,
    );
  }
}

export type Migration = (db: DatabaseSync) => void;

export function runMigrations(db: DatabaseSync, migrations: Migration[]) {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  migrations.slice(version).forEach((migration, i) => {
    db.exec("BEGIN");
    try {
      migration(db);
      db.exec(`PRAGMA user_version = ${version + i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures to avoid masking the original error.
      }
      throw err;
    }
  });
}
