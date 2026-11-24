// Chart-only paired history inputs. Reporting retains its own complete metadata
// reads and checkpoints. Pages are published only after a settled hour finishes.
import { randomUUID } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { isBusy, withoutBusyWait } from "../storage.js";
import { Temporal } from "@js-temporal/polyfill";
import { BATHY_REPORT_DELAY } from "../constants.js";
import {
  Timeframe,
  type BathymetryData,
  type BathymetrySource,
} from "../types.js";

const HOUR = 3600_000;
const PAGE = 1000;
// Misbehaving providers cannot make one hour consume unbounded disk.
const MAX_ROWS = 100_000;
// Retain recoverable inputs; when full, stream without adding cache data.
const MAX_BYTES = 256 * 1024 * 1024;
type Row = [number, number, number, number, number | null];

/** Shared by preview and refinement, with an identity independent of derived QC. */
export async function cacheChartInputs(
  db: DatabaseSync,
  source: BathymetrySource,
  identity: string,
  signal: AbortSignal,
): Promise<BathymetrySource> {
  async function write<T>(action: () => T, cleanup = false): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (true) {
      if (!cleanup) signal.throwIfAborted();
      try {
        return withoutBusyWait(db, action);
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw error;
        await sleep(100, undefined, cleanup ? undefined : { signal });
      }
    }
  }
  await write(() =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS chart_input_chunks (
      identity TEXT NOT NULL, start INTEGER NOT NULL, token TEXT NOT NULL,
      PRIMARY KEY(identity, start)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS chart_input_token ON chart_input_chunks(token);
    CREATE TABLE IF NOT EXISTS chart_input_boxes (
      id INTEGER PRIMARY KEY, token TEXT NOT NULL, part INTEGER NOT NULL, UNIQUE(token,part)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chart_input_spatial USING rtree(id,minX,maxX,minY,maxY);
    CREATE TABLE IF NOT EXISTS chart_input_pages (
      token TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY(token, part)
    ) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS chart_input_page_delete AFTER DELETE ON chart_input_pages BEGIN
      DELETE FROM chart_input_spatial WHERE id IN (SELECT id FROM chart_input_boxes WHERE token=OLD.token AND part=OLD.part);
      DELETE FROM chart_input_boxes WHERE token=OLD.token AND part=OLD.part;
    END;
  `),
  );
  const lookup = db.prepare(
    "SELECT token FROM chart_input_chunks WHERE identity = ? AND start = ?",
  );
  const page = db.prepare(
    "SELECT data FROM chart_input_pages WHERE token = ? AND part = ?",
  );
  const insert = db.prepare("INSERT INTO chart_input_pages VALUES (?, ?, ?)");
  const publish = db.prepare(
    "INSERT OR IGNORE INTO chart_input_chunks VALUES (?, ?, ?)",
  );
  const discard = db.prepare("DELETE FROM chart_input_pages WHERE token = ?");
  let bytes = Number(
    (
      db
        .prepare(
          "SELECT coalesce(sum(length(data)), 0) AS bytes FROM chart_input_pages",
        )
        .get() as { bytes: number }
    ).bytes,
  );
  const pending = new Map<number, Promise<void>>();
  const reader = source.createPreviewReader ?? source.createReader;

  // Timed-out provider calls may still run. Keep their slots until they settle;
  // cached reads remain available and retries cannot stack identical queries.
  const requests = new Set<string>();
  async function request<T>(
    key: string,
    run: () => T | Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (requests.has(key) || requests.size >= 4)
      throw new Error("Chart provider request still pending; will retry");
    requests.add(key);
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const pending = Promise.resolve().then(run);
    void pending.then(
      (value) => {
        requests.delete(key);
        if (expired && value instanceof Readable) value.destroy();
      },
      () => {
        requests.delete(key);
      },
    );
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(signal.reason ?? new Error("Chart acquisition stopped"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => reject(new Error("Chart provider request timed out; will retry")),
        30_000,
      );
    });
    try {
      return await Promise.race([pending, cancelled]);
    } catch (err) {
      expired = true;
      throw err;
    } finally {
      clearTimeout(timer!);
      signal.removeEventListener("abort", abort!);
    }
  }

  function cached(start: number): string | undefined {
    return (lookup.get(identity, start) as { token: string } | undefined)
      ?.token;
  }
  async function* replay(token: string) {
    for (let part = 0; !signal.aborted; part++) {
      const found = page.get(token, part) as { data: Uint8Array } | undefined;
      if (!found) return;
      const rows = JSON.parse(inflateSync(found.data).toString()) as Row[];
      for (const [time, longitude, latitude, depth, heading] of rows) {
        if (signal.aborted) return;
        yield {
          timestamp: Temporal.Instant.fromEpochMilliseconds(time),
          longitude,
          latitude,
          depth,
          ...(heading === null ? {} : { heading }),
        } satisfies BathymetryData;
      }
    }
  }

  function createReader(window: Timeframe) {
    return Readable.from(
      (async function* () {
        const start = window.from.epochMilliseconds;
        // Partial and mutable tail reads must never masquerade as a complete hour.
        const eligible =
          start % HOUR === 0 &&
          window.to.epochMilliseconds === start + HOUR &&
          Temporal.Instant.compare(
            window.to,
            Temporal.Now.instant().subtract(BATHY_REPORT_DELAY),
          ) <= 0;
        if (eligible) {
          while (pending.has(start)) await pending.get(start);
          if (signal.aborted) return;
          const token = cached(start);
          if (token) {
            yield* replay(token);
            return;
          }
        }
        let release: (() => void) | undefined;
        if (eligible)
          pending.set(
            start,
            new Promise<void>((resolve) => {
              release = resolve;
            }),
          );
        const token = randomUUID();
        let part = 0;
        let rows: Row[] = [];
        let count = 0;
        let published = false;
        let storedBytes = 0;
        let cacheFull = bytes >= MAX_BYTES;
        let upstream: Readable | undefined;
        const abort = () =>
          upstream?.destroy(new Error("Chart input acquisition stopped"));
        const save = async () => {
          if (!rows.length || signal.aborted) return;
          const saving = rows;
          const encoded = deflateSync(JSON.stringify(saving));
          rows = [];
          if (bytes + encoded.length > MAX_BYTES) {
            cacheFull = true;
            return;
          }
          const saved = await write(() => {
            if (bytes + encoded.length > MAX_BYTES) return false;
            db.exec("SAVEPOINT chart_input_page");
            try {
              insert.run(token, part, encoded);
              const points = saving.filter(
                (r) =>
                  Number.isFinite(r[1]) &&
                  Number.isFinite(r[2]) &&
                  Math.abs(r[1]) <= 180 &&
                  Math.abs(r[2]) <= 90,
              );
              if (points.length) {
                const id = db
                  .prepare(
                    "INSERT INTO chart_input_boxes(token,part) VALUES(?,?) RETURNING id",
                  )
                  .get(token, part)!.id;
                db.prepare(
                  "INSERT INTO chart_input_spatial VALUES(?,?,?,?,?)",
                ).run(
                  id,
                  Math.min(...points.map((p) => p[1])),
                  Math.max(...points.map((p) => p[1])),
                  Math.min(...points.map((p) => p[2])),
                  Math.max(...points.map((p) => p[2])),
                );
              }
              db.exec("RELEASE chart_input_page");
            } catch (err) {
              db.exec("ROLLBACK TO chart_input_page; RELEASE chart_input_page");
              throw err;
            }
            bytes += encoded.length;
            return true;
          });
          if (!saved) {
            cacheFull = true;
            return;
          }
          part++;
          storedBytes += encoded.length;
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          upstream = await request(`read:${window.from}/${window.to}`, () =>
            reader(window),
          );
          if (signal.aborted) {
            upstream?.destroy();
            return;
          }
          // Undefined is unavailable, not proof of an empty completed interval.
          if (!upstream) return;
          for await (const value of upstream) {
            if (signal.aborted) return;
            const data = value as BathymetryData;
            const time = data.timestamp.epochMilliseconds;
            // Providers may include the upper boundary. Keep all paths half-open.
            if (time < start || time >= window.to.epochMilliseconds) continue;
            if (eligible && !cacheFull && ++count <= MAX_ROWS) {
              rows.push([
                time,
                data.longitude,
                data.latitude,
                data.depth,
                data.heading ?? null,
              ]);
              if (rows.length === PAGE) await save();
            }
            yield data;
          }
          if (
            eligible &&
            count > 0 &&
            count <= MAX_ROWS &&
            !cacheFull &&
            !signal.aborted
          ) {
            await save();
            if (!cacheFull) {
              await write(() => publish.run(identity, start, token));
              published = cached(start) === token;
            }
          }
        } finally {
          signal.removeEventListener("abort", abort);
          upstream?.destroy();
          try {
            if (!published && storedBytes) {
              await write(() => discard.run(token), true);
              bytes -= storedBytes;
            }
          } finally {
            if (eligible) pending.delete(start);
            release?.();
          }
        }
      })(),
    );
  }

  return {
    ...source,
    createReader,
    createPreviewReader: createReader,
    getAvailableTimeframes: (span, resolution) =>
      request(`availability:${span.from}/${span.to}/${resolution}`, () =>
        source.getAvailableTimeframes(span, resolution),
      ),
    getStoredTimeframes(span, [west, south, east, north]) {
      const ranges =
        west > east
          ? [
              [west, 180],
              [-180, east],
            ]
          : [[west, east]];
      const refined = !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='refined_windows'")
        .get();
      const query =
        db.prepare(`SELECT DISTINCT c.start FROM chart_input_spatial s
        JOIN chart_input_boxes b ON b.id=s.id JOIN chart_input_chunks c ON c.token=b.token
        WHERE c.identity=? AND c.start>=? AND c.start<? AND s.maxX>=? AND s.minX<=?
          AND s.maxY>=? AND s.minY<=?
        ${refined ? "AND NOT EXISTS (SELECT 1 FROM refined_windows r WHERE r.start=c.start AND r.end=c.start+3600000) AND NOT EXISTS (SELECT 1 FROM refined_empty_windows r WHERE r.start=c.start AND r.end=c.start+3600000)" : ""}
        ORDER BY c.start DESC LIMIT 64`);
      const starts = new Set<number>();
      for (const [w, e] of ranges)
        for (const row of query.all(
          identity,
          Math.floor(span.from.epochMilliseconds / HOUR) * HOUR,
          span.to.epochMilliseconds,
          w,
          e,
          south,
          north,
        ))
          starts.add(row.start as number);
      return [...starts]
        .sort((a, b) => b - a)
        .slice(0, 64)
        .map((start) =>
          new Timeframe(
            Temporal.Instant.fromEpochMilliseconds(start),
            Temporal.Instant.fromEpochMilliseconds(start + HOUR),
          ).clamp(span),
        );
    },
  };
}
