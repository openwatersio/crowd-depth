import { DatabaseSync, StatementSync } from "node:sqlite";
import { BathymetryData, BathymetrySource, Timeframe } from "../types.js";
import { Readable, Writable } from "stream";
import { ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";
import { BATHY_EPOCH } from "../constants.js";

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
  db: DatabaseSync,
): BathymetrySource {
  app.debug(`Using SQLite source`);

  return {
    createWriter: () => createSqliteWriter(db),

    createReader(options) {
      return createSqliteReader(db, options);
    },

    getAvailableTimeframes(timeframe, windowSize) {
      const fromMs = timeframe.from.epochMilliseconds;
      const toMs = timeframe.to.epochMilliseconds;
      const bucketMs = windowSize.total("milliseconds");

      // From each window with data to the next, one index lookup apiece: grouping every
      // sounding in a year of them would hold the server up for many seconds.
      const next = db.prepare(
        `SELECT min(timestamp) AS t FROM bathymetry WHERE timestamp >= ? AND timestamp < ?`,
      );
      const windows: Timeframe[] = [];
      let at = fromMs;
      for (;;) {
        const { t } = next.get(at, toMs) as { t: number | null };
        if (t === null) return windows;
        const start = fromMs + Math.floor((t - fromMs) / bucketMs) * bucketMs;
        windows.push(
          new Timeframe(
            Temporal.Instant.fromEpochMilliseconds(start),
            Temporal.Instant.fromEpochMilliseconds(start + bucketMs),
          ),
        );
        at = start + bucketMs;
      }
    },
  };
}

export interface SqliteReaderOptions {
  batchSize?: number;
  from?: Temporal.Instant;
  to?: Temporal.Instant;
}

export function createSqliteReader(
  db: DatabaseSync,
  options: SqliteReaderOptions = {},
) {
  const {
    batchSize = 1000,
    from = BATHY_EPOCH,
    to = Temporal.Now.instant(),
  } = options;

  const { count } = db
    .prepare(
      `SELECT count(*) as count FROM bathymetry WHERE timestamp >= :from AND timestamp < :to`,
    )
    .get({
      from: from.epochMilliseconds,
      to: to.epochMilliseconds,
    }) as { count: number };

  if (count <= 0) return;

  let offset = 0;
  let query: StatementSync;

  return new Readable({
    objectMode: true,
    construct(callback) {
      try {
        query = db.prepare(`
          SELECT * FROM bathymetry
          WHERE timestamp >= :from AND timestamp < :to
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
      }) as BathymetryRow[];

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

export function createSqliteWriter(db: DatabaseSync) {
  let stmt: StatementSync;

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
      // The chart's backfill writes from a second connection; a write that finds it
      // holding the lock past the busy timeout is tried again before the log gives up.
      const attempt = (left: number) => {
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
          if (left > 0 && isBusy(err))
            setTimeout(() => attempt(left - 1), 1000);
          else callback(err as Error);
        }
      };
      attempt(BUSY_RETRIES);
    },
  });
}

/** Writes the log tries again when another connection holds the database. */
const BUSY_RETRIES = 3;

const isBusy = (err: unknown) =>
  /SQLITE_BUSY|database is locked/i.test(
    `${(err as { errstr?: string }).errstr ?? ""} ${String(err)}`,
  );
