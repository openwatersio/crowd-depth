import type { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { ObservationDataError, isObservationDataError } from "./errors.js";
import type { Acquisition, Chunk, Observation } from "./store.js";

const SCALE = 10_000_000;
const DAY = 86_400_000;
type Bounds = readonly [number, number, number, number];
type Original = { version: 1; acquisition: Acquisition; points: Observation[] };

/** Derived discovery for live originals, independent of historical receipts.
 * Older writers can keep appending: the next migration pass finds new IDs. */
export function createCaptureIndex(db: DatabaseSync) {
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS observation_capture_spatial USING rtree_i32(
      id,min_lon,max_lon,min_lat,max_lat,min_context,max_context,min_day,max_day,min_chunk,max_chunk
    )`);
  } catch (error) {
    if (!String(error).includes("no such module: rtree_i32")) throw error;
    db.exec(`CREATE TABLE IF NOT EXISTS observation_capture_spatial(
      id INTEGER PRIMARY KEY,min_lon INTEGER,max_lon INTEGER,min_lat INTEGER,max_lat INTEGER,
      min_context INTEGER,max_context INTEGER,min_day INTEGER,max_day INTEGER,min_chunk INTEGER,max_chunk INTEGER
    ); CREATE INDEX IF NOT EXISTS observation_capture_context ON observation_capture_spatial(min_context,min_chunk);`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS observation_capture_scan(
      start INTEGER PRIMARY KEY, before INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observation_capture_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS observation_capture_errors(id INTEGER PRIMARY KEY,error TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS observation_capture_delete AFTER DELETE ON observation_chunks BEGIN
      DELETE FROM observation_capture_spatial WHERE id=OLD.id;
      DELETE FROM observation_capture_errors WHERE id=OLD.id;
    END;`);

  function put(
    id: number,
    acquisition: Acquisition,
    start: number,
    end: number,
    bounds: Bounds,
  ) {
    if (acquisition.kind !== "live") return;
    const identity = JSON.stringify(acquisition);
    db.prepare(
      "INSERT OR IGNORE INTO observation_import_contexts(identity) VALUES(?)",
    ).run(identity);
    const context = Number(
      db
        .prepare("SELECT id FROM observation_import_contexts WHERE identity=?")
        .get(identity)!.id,
    );
    if (context > 2147483647 || id > 2147483647)
      throw new Error("Capture spatial index exhausted");
    const [west, south, east, north] = bounds;
    db.prepare(
      "INSERT OR REPLACE INTO observation_capture_spatial VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      Math.floor(west * SCALE),
      Math.ceil(east * SCALE),
      Math.floor(south * SCALE),
      Math.ceil(north * SCALE),
      context,
      context,
      Math.floor(start / DAY),
      Math.floor(end / DAY),
      id,
      id,
    );
    db.prepare("DELETE FROM observation_capture_errors WHERE id=?").run(id);
  }

  return {
    put,
    /** At most sixteen originals decoded and one durable transaction per call. */
    migrate(read: (id: number) => Original | undefined) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const head = Number(
          db
            .prepare("SELECT coalesce(max(id),0) AS id FROM observation_chunks")
            .get()!.id,
        );
        const seen = Number(
          db
            .prepare(
              "SELECT value FROM observation_capture_meta WHERE key='head'",
            )
            .get()?.value ?? 0,
        );
        if (head > seen) {
          db.prepare("INSERT INTO observation_capture_scan VALUES(?,?)").run(
            seen + 1,
            head + 1,
          );
          db.prepare(
            "INSERT OR REPLACE INTO observation_capture_meta VALUES('head',?)",
          ).run(head);
        }
        const range = db
          .prepare(
            "SELECT start,before FROM observation_capture_scan ORDER BY start DESC LIMIT 1",
          )
          .get();
        const errors: { id: number; error: string }[] = [];
        let processed = 0;
        if (range) {
          const rows = db
            .prepare(
              "SELECT id FROM observation_chunks WHERE id>=? AND id<? ORDER BY id DESC LIMIT 16",
            )
            .all(range.start, range.before);
          for (const row of rows) {
            const id = Number(row.id);
            processed++;
            if (
              db
                .prepare("SELECT 1 FROM observation_capture_spatial WHERE id=?")
                .get(id)
            )
              continue;
            let original: Original;
            let start = Infinity,
              end = -Infinity,
              west = Infinity,
              east = -Infinity,
              south = Infinity,
              north = -Infinity;
            try {
              const found = read(id);
              if (
                !found ||
                found.version !== 1 ||
                !found.acquisition ||
                !["live", "history-aggregate", "legacy-corrected"].includes(
                  found.acquisition.kind,
                ) ||
                !Array.isArray(found.points)
              )
                throw new ObservationDataError(`Invalid original chunk ${id}`);
              original = found;
              if (original.acquisition.kind !== "live") continue;
              if (
                !original.points.length ||
                original.points.length > 512 ||
                typeof original.acquisition.depthPath !== "string" ||
                !original.acquisition.depthPath ||
                !original.acquisition.settings ||
                typeof original.acquisition.settings !== "object" ||
                Array.isArray(original.acquisition.settings)
              )
                throw new ObservationDataError(`Invalid capture chunk ${id}`);
              for (const point of original.points) {
                if (
                  !point ||
                  ![point.longitude, point.latitude, point.depth].every(
                    Number.isFinite,
                  ) ||
                  Math.abs(point.longitude) > 180 ||
                  Math.abs(point.latitude) > 90
                )
                  throw new ObservationDataError(
                    `Invalid capture coordinates ${id}`,
                  );
                let time: number;
                try {
                  time = Temporal.Instant.from(
                    point.timestamp,
                  ).epochMilliseconds;
                } catch {
                  throw new ObservationDataError(
                    `Invalid capture timestamp ${id}`,
                  );
                }
                start = Math.min(start, time);
                end = Math.max(end, time);
                west = Math.min(west, point.longitude);
                east = Math.max(east, point.longitude);
                south = Math.min(south, point.latitude);
                north = Math.max(north, point.latitude);
              }
            } catch (error) {
              if (!isObservationDataError(error)) throw error;
              const message = String(error);
              db.prepare(
                "INSERT OR REPLACE INTO observation_capture_errors VALUES(?,?)",
              ).run(id, message);
              errors.push({ id, error: message });
              continue;
            }
            // Query headers are derived too; verified originals are authoritative.
            db.prepare(
              "UPDATE observation_chunks SET start=?,end=?,count=? WHERE id=?",
            ).run(start, end, original.points.length, id);
            put(id, original.acquisition, start, end, [
              west,
              south,
              east,
              north,
            ]);
          }
          if (
            rows.length === 16 &&
            Number(rows.at(-1)!.id) > Number(range.start)
          )
            db.prepare(
              "UPDATE observation_capture_scan SET before=? WHERE start=?",
            ).run(rows.at(-1)!.id, range.start);
          else
            db.prepare(
              "DELETE FROM observation_capture_scan WHERE start=?",
            ).run(range.start);
        }
        const done = !db
          .prepare("SELECT 1 FROM observation_capture_scan LIMIT 1")
          .get();
        const incomplete = !!db
          .prepare("SELECT 1 FROM observation_capture_errors LIMIT 1")
          .get();
        db.exec("COMMIT");
        return { processed, done, incomplete, errors };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    page(
      identity: string,
      from: number,
      to: number,
      bounds: Bounds,
      before?: number,
    ): { chunks: Chunk[]; before?: number } {
      const [west, south, east, north] = bounds;
      if (
        !identity ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        to <= from ||
        bounds.some((v) => !Number.isFinite(v)) ||
        Math.abs(west) > 180 ||
        Math.abs(east) > 180 ||
        Math.abs(south) > 90 ||
        Math.abs(north) > 90 ||
        south > north ||
        (before !== undefined &&
          (!Number.isInteger(before) || before < 1 || before > 2147483648))
      )
        throw new Error("Invalid captured observation viewport");
      const context = db
        .prepare("SELECT id FROM observation_import_contexts WHERE identity=?")
        .get(identity)?.id;
      if (context === undefined) return { chunks: [] };
      const query = db.prepare(`SELECT s.id FROM observation_capture_spatial s
        WHERE s.min_context<=? AND s.max_context>=? AND s.min_day<=? AND s.max_day>=?
          AND s.max_lon>=? AND s.min_lon<=? AND s.max_lat>=? AND s.min_lat<=?
          AND s.min_chunk<? AND s.max_chunk>? LIMIT 65`);
      let upper =
        before ??
        Number(
          db
            .prepare(
              "SELECT coalesce(max(id),0)+1 AS next FROM observation_chunks",
            )
            .get()!.next,
        );
      let lower = 0;
      for (let attempt = 0; attempt < 64; attempt++) {
        const found = new Set<number>();
        for (const [w, e] of west <= east
          ? [[west, east]]
          : [
              [west, 180],
              [-180, east],
            ]) {
          const rows = query.all(
            context,
            context,
            Math.floor((to - 1) / DAY),
            Math.floor(from / DAY),
            Math.floor(w * SCALE),
            Math.ceil(e * SCALE),
            Math.floor(south * SCALE),
            Math.ceil(north * SCALE),
            upper,
            lower,
          );
          for (const row of rows) found.add(Number(row.id));
        }
        if (found.size > 64) lower = Math.floor((lower + upper) / 2);
        else if (!found.size && lower > 0) {
          upper = lower + 1;
          lower = 0;
        } else {
          // Limit spatial candidates before exact time filtering, including empty pages.
          const chunks = db
            .prepare(
              "SELECT id,key,start,end,count FROM observation_chunks WHERE id IN (SELECT value FROM json_each(?))",
            )
            .all(JSON.stringify([...found])) as unknown as Chunk[];
          if (chunks.length !== found.size)
            throw new ObservationDataError(
              "Capture index references missing originals",
            );
          return {
            chunks: chunks
              .filter((c) => c.start < to && c.end >= from)
              .sort((a, b) => b.start - a.start || b.id - a.id),
            ...(lower > 0 ? { before: lower + 1 } : {}),
          };
        }
      }
      throw new Error("Captured viewport paging exceeded its work budget");
    },
  };
}
