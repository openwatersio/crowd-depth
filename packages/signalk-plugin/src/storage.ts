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
      // The chart layer's encoded tiles, kept so a restart doesn't build them again;
      // see tiles/kept.ts. A tile's boxes are the cells, overview blocks and shoals it
      // was built from, one per 1° band, whose columns are its own. The triggers drop a
      // tile whenever a row under one of its boxes changes, whichever build of the
      // plugin writes it, so a kept tile never outlives what it was built from, even
      // after a rollback to a build that doesn't know about them.
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
        CREATE VIRTUAL TABLE IF NOT EXISTS kept_tile_boxes USING rtree_i32(id, py0, py1, px0, px1, +tile);
        CREATE TRIGGER IF NOT EXISTS kept_tiles_drop AFTER DELETE ON kept_tiles BEGIN
          DELETE FROM kept_tile_boxes WHERE tile = OLD.id;
        END;
      `);
      const under = (row: string, reach = "0") => `
        DELETE FROM kept_tiles WHERE id IN (
          SELECT tile FROM kept_tile_boxes
          WHERE py0 <= ${row}.py + ${reach} AND py1 >= ${row}.py - ${reach}
            AND px0 <= ${row}.px + ${reach} AND px1 >= ${row}.px - ${reach});`;
      // An overview block reaches 2^level cells from the cell it holds.
      for (const [table, reach] of [
        ["cells", "0"],
        ["shoals", "0"],
        ["overviews", "(1 << {}.level)"],
      ]) {
        const r = (row: string) => reach.replace("{}", row);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS kept_tiles_${table}_insert AFTER INSERT ON ${table} BEGIN
            ${under("NEW", r("NEW"))}
          END;
          CREATE TRIGGER IF NOT EXISTS kept_tiles_${table}_update AFTER UPDATE ON ${table} BEGIN
            ${under("OLD", r("OLD"))}
            ${under("NEW", r("NEW"))}
          END;
          CREATE TRIGGER IF NOT EXISTS kept_tiles_${table}_delete AFTER DELETE ON ${table} BEGIN
            ${under("OLD", r("OLD"))}
          END;
        `);
      }
    },
  ]);

  return db;
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
