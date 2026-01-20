import Database from "better-sqlite3";
import { BathymetryData, BathymetrySource } from "../types.js";
import { Readable, Writable } from "stream";
import { ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";

type BathymetryRow = {
  id: number;
  longitude: number;
  latitude: number;
  depth: number;
  timestamp: number;
  heading: number | null;
};

export function createSqliteSource(
  app: ServerAPI,
  db: Database.Database,
): BathymetrySource {
  app.debug(`Using SQLite source`);

  return {
    createWriter: () => createSqliteWriter(db),
    createReader(options) {
      return createSqliteReader(db, options);
    },
  };
}

export interface SqliteReaderOptions {
  batchSize?: number;
  from?: Temporal.Instant;
  to?: Temporal.Instant;
}

type QueryOptions = {
  limit: number;
  offset: number;
  from?: number;
  to?: number;
};

export function createSqliteReader(
  db: Database.Database,
  options: SqliteReaderOptions = {},
) {
  const {
    batchSize = 1000,
    from = Temporal.Instant.fromEpochMilliseconds(0),
    to = Temporal.Now.instant(),
  } = options;

  const { count } = db
    .prepare<
      { from: number; to: number },
      { count: number }
    >(`SELECT count(*) as count FROM bathymetry WHERE timestamp >= :from AND timestamp <= :to`)
    .get({ from: from.epochMilliseconds, to: to.epochMilliseconds })!;

  if (count <= 0) return;

  let offset = 0;
  let query: Database.Statement<QueryOptions, BathymetryRow>;

  return new Readable({
    objectMode: true,
    construct(callback) {
      try {
        query = db.prepare(`
          SELECT * FROM bathymetry
          WHERE timestamp >= :from AND timestamp <= :to
          ORDER BY timestamp
          LIMIT :limit OFFSET :offset
        `);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    read() {
      const rows = query.all({
        limit: batchSize,
        offset,
        from: from.epochMilliseconds,
        to: to.epochMilliseconds,
      });

      rows.forEach(({ longitude, latitude, depth, timestamp, heading }) => {
        this.push({
          longitude,
          latitude,
          depth,
          timestamp: Temporal.Instant.fromEpochMilliseconds(timestamp),
          heading,
        } as BathymetryData);
      });

      offset += rows.length;

      if (rows.length < batchSize) this.push(null);
    },
  });
}

export function createSqliteWriter(db: Database.Database) {
  let stmt: Database.Statement<Omit<BathymetryRow, "id">>;

  return new Writable({
    objectMode: true,
    construct(callback) {
      try {
        stmt = db.prepare(`
          INSERT INTO bathymetry(longitude, latitude, depth, timestamp, heading)
          VALUES(:longitude, :latitude, :depth, :timestamp, :heading)
        `);

        callback();
      } catch (err) {
        callback(err as Error);
      }
    },

    write(data: BathymetryData, encoding, callback) {
      try {
        stmt.run({
          longitude: data.longitude,
          latitude: data.latitude,
          depth: data.depth,
          timestamp: data.timestamp.epochMilliseconds,
          heading: data.heading ?? null,
        });
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}
