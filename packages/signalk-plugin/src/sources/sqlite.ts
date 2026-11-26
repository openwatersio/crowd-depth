import { DatabaseSync, StatementSync } from "node:sqlite";
import { BathymetryData, BathymetrySource, Timeframe } from "../types.js";
import { Readable, Writable } from "stream";
import { ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";
import { BATHY_EPOCH } from "../constants.js";
import { withoutBusyWait, isBusy } from "../storage.js";

type BathymetryRow = {
  id: number;
  longitude: number;
  latitude: number;
  depth: number;
  timestamp: number;
  heading: number | null;
  gnss: string | null;
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

  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("SQLite reader batchSize must be a positive integer");
  // An existence seek is enough; counting a multi-year history delays its first row.
  if (
    !db
      .prepare(
        "SELECT 1 FROM bathymetry WHERE timestamp >= ? AND timestamp < ? LIMIT 1",
      )
      .get(from.epochMilliseconds, to.epochMilliseconds)
  )
    return;

  let after = from.epochMilliseconds;
  let id = -1;
  let query: StatementSync;
  let tied: StatementSync;

  return new Readable({
    objectMode: true,
    construct(callback) {
      try {
        // Two seeks avoid scanning every earlier row with the same timestamp:
        // SQLite's timestamp index includes rowid and can seek both on equality.
        tied = db.prepare(`SELECT * FROM bathymetry
          WHERE timestamp=? AND id>? ORDER BY id LIMIT ?`);
        query = db.prepare(`SELECT * FROM bathymetry
          WHERE timestamp>? AND timestamp<? ORDER BY timestamp,id LIMIT ?`);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    read() {
      const rows = tied.all(after, id, batchSize) as BathymetryRow[];
      if (rows.length < batchSize)
        rows.push(
          ...(query.all(
            after,
            to.epochMilliseconds,
            batchSize - rows.length,
          ) as BathymetryRow[]),
        );

      rows.forEach(
        ({ longitude, latitude, depth, timestamp, heading, gnss }) => {
          this.push({
            longitude,
            latitude,
            depth,
            timestamp: Temporal.Instant.fromEpochMilliseconds(timestamp),
            heading,
            ...(gnss ? { gnss: JSON.parse(gnss) } : {}),
          } as BathymetryData);
        },
      );

      if (rows.length) {
        after = rows.at(-1)!.timestamp;
        id = rows.at(-1)!.id;
      }

      if (rows.length < batchSize) this.push(null);
    },
  });
}

export function createSqliteWriter(db: DatabaseSync) {
  let stmt: StatementSync;
  let retry: ReturnType<typeof setTimeout> | undefined;

  return new Writable({
    objectMode: true,
    construct(callback) {
      try {
        stmt = db.prepare(`
          INSERT INTO bathymetry(longitude, latitude, depth, timestamp, heading, gnss)
          VALUES(:longitude, :latitude, :depth, :timestamp, :heading, :gnss)
        `);

        callback();
      } catch (err) {
        callback(err as Error);
      }
    },

    write(data: BathymetryData, encoding, callback) {
      // Retry with stream backpressure, leaving the server responsive while locked.
      const attempt = (left: number) => {
        if (this.destroyed) return;
        try {
          withoutBusyWait(db, () =>
            stmt.run({
              longitude: data.longitude,
              latitude: data.latitude,
              depth: data.depth,
              timestamp: data.timestamp.epochMilliseconds,
              heading: data.heading ?? null,
              gnss: data.gnss ? JSON.stringify(data.gnss) : null,
            }),
          );
          callback();
        } catch (err) {
          if (left > 0 && isBusy(err))
            retry = setTimeout(() => attempt(left - 1), 100);
          else callback(err as Error);
        }
      };
      attempt(BUSY_RETRIES);
    },
    destroy(error, callback) {
      clearTimeout(retry);
      callback(error);
    },
  });
}

/** Writes the log tries again when another connection holds the database. */
const BUSY_RETRIES = 240;
