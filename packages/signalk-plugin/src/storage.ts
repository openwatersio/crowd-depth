import { DatabaseSync } from "node:sqlite";

export function createDB(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL");

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
