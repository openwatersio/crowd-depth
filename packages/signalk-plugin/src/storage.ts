import { DatabaseSync } from "node:sqlite";

export function createDB(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL");
  // Skip per-commit fsync so 1Hz depth inserts don't wear out SD cards (#100).
  // WAL + NORMAL is durable against corruption; worst case loses recent rows on power loss.
  db.exec("PRAGMA synchronous = NORMAL");

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
        CREATE INDEX IF NOT EXISTS idx_bathymetry_location ON bathymetry(latitude, longitude);
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
