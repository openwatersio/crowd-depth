import { createCaptureIndex } from "./capture-index.js";
import { mergeObservationGroups } from "./merge.js";
import { ObservationDataError, ObservationReadBusy } from "./errors.js";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { deflateSync, inflateSync } from "node:zlib";
import { Temporal } from "@js-temporal/polyfill";
import type { GnssQuality } from "../gnss-quality.js";

/** Values before chart corrections or rounding; absent metadata stays unknown. */
export interface Observation {
  timestamp: string;
  longitude: number;
  latitude: number;
  depth: number;
  positionTimestamp?: string;
  timestampEstimated?: boolean;
  positionTimestampEstimated?: boolean;
  depthSource?: string;
  positionSource?: string;
  headingTrue?: number;
  courseOverGroundTrue?: number;
  speedOverGround?: number;
  gnss?: GnssQuality;
  /** Optional acquisition requests failed or could not attribute their results. */
  metadataIncomplete?: boolean;
}

export interface Acquisition {
  kind: "live" | "history-aggregate" | "legacy-corrected";
  depthPath: string;
  /** Exact saved acquisition/calibration settings, not proof of actual source. */
  settings: Record<string, unknown>;
}
export type AcquisitionStage = "preview" | "partial" | "full";
/** Exceptions to the receipt's acquisition time/stage, for retained timestamp groups. */
export type ObservationOrigin = [
  time: string,
  recorded: number,
  stage: AcquisitionStage,
];
function parseManifest(value: string): number[] {
  try {
    const ids = JSON.parse(value);
    if (
      !Array.isArray(ids) ||
      ids.length > Math.ceil(MAX_IMPORT_POINTS / CHUNK_POINTS) ||
      ids.some((id) => !Number.isSafeInteger(id) || id < 1)
    )
      throw new Error("invalid chunk references");
    return ids;
  } catch (cause) {
    throw new ObservationDataError(
      "Observation import manifest is unreadable",
      { cause },
    );
  }
}
function encodeOrigins(origins: ObservationOrigin[]) {
  if (!origins.length) return null;
  const bytes = Buffer.from(JSON.stringify(origins));
  return Buffer.concat([
    createHash("sha256").update(bytes).digest(),
    deflateSync(bytes),
  ]);
}
function decodeOrigins(data: Uint8Array): ObservationOrigin[] {
  try {
    const bytes = inflateSync(data.subarray(32), {
      maxOutputLength: 16 * 1024 * 1024,
    });
    if (
      !createHash("sha256")
        .update(bytes)
        .digest()
        .equals(Buffer.from(data.subarray(0, 32)))
    )
      throw new Error("checksum mismatch");
    const origins = JSON.parse(bytes.toString());
    if (
      !Array.isArray(origins) ||
      origins.length > MAX_IMPORT_POINTS ||
      origins.some(
        (o) =>
          !Array.isArray(o) ||
          o.length !== 3 ||
          typeof o[0] !== "string" ||
          !/^-?[0-9]+$/.test(o[0]) ||
          !Number.isSafeInteger(o[1]) ||
          !["preview", "partial", "full"].includes(o[2]),
      )
    )
      throw new Error("invalid observation origins");
    return origins;
  } catch (cause) {
    throw new ObservationDataError(
      "Observation revision origins are unreadable",
      { cause },
    );
  }
}

export const CHUNK_POINTS = 512;
export const MAX_IMPORT_POINTS = 100000;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const SCALE = 1e7;
const RESERVE_BYTES = 256 * 1024 * 1024;
const DAY = 86400000;
type Bounds = readonly [number, number, number, number];
export interface Chunk {
  id: number;
  key: string;
  start: number;
  end: number;
  count: number;
}

/** Worker-owned, lossless storage, separate from disposable chart databases. */
export function openObservationStore(file: string) {
  const db = new DatabaseSync(file);
  let captures: ReturnType<typeof createCaptureIndex>;
  let nextRead = 0;
  const mergedReads = new Map<
    number,
    { points: Observation[]; offset: number }
  >();
  let insert: StatementSync,
    existing: StatementSync,
    spatial: StatementSync,
    read: StatementSync;
  try {
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;",
    );
    const version = Number(
      db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (![0, 1, 2, 3, 4, 5, 6, 7].includes(version))
      throw new Error(`Unsupported observation store version ${version}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS observation_chunks (
        id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE,
        start INTEGER NOT NULL, end INTEGER NOT NULL, count INTEGER NOT NULL,
        data BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observation_chunks_time ON observation_chunks(start, end);`);
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS observation_spatial USING rtree_i32(
        id, min_lon, max_lon, min_lat, max_lat
      );`);
    } catch (error) {
      if (!String(error).includes("no such module: rtree_i32")) throw error;
      db.exec(`CREATE TABLE IF NOT EXISTS observation_spatial (
        id INTEGER PRIMARY KEY, min_lon INTEGER, max_lon INTEGER, min_lat INTEGER, max_lat INTEGER
      ); CREATE INDEX IF NOT EXISTS observation_spatial_lon ON observation_spatial(min_lon,max_lon);`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS observation_imports (
      identity TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
      recorded INTEGER NOT NULL, chunks TEXT NOT NULL, PRIMARY KEY(identity,start,end)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS observation_import_contexts (
      id INTEGER PRIMARY KEY, identity TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS observation_import_windows (
      id INTEGER PRIMARY KEY, identity TEXT NOT NULL, start INTEGER NOT NULL,
      end INTEGER NOT NULL, UNIQUE(identity,start,end)
    );
    `);
    if (
      !db
        .prepare("PRAGMA table_info(observation_imports)")
        .all()
        .some((column) => column.name === "stage")
    )
      db.exec(
        "ALTER TABLE observation_imports ADD COLUMN stage TEXT NOT NULL DEFAULT 'preview'",
      );
    try {
      if (version < 4)
        db.exec("DROP TABLE IF EXISTS observation_import_spatial");
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS observation_import_spatial USING rtree_i32(
        id,min_lon,max_lon,min_lat,max_lat,min_context,max_context,min_day,max_day,min_window,max_window
      );`);
    } catch (error) {
      if (!String(error).includes("no such module: rtree_i32")) throw error;
      db.exec(`CREATE TABLE IF NOT EXISTS observation_import_spatial (
        id INTEGER PRIMARY KEY,min_lon INTEGER,max_lon INTEGER,min_lat INTEGER,max_lat INTEGER,
        min_context INTEGER,max_context INTEGER,min_day INTEGER,max_day INTEGER,min_window INTEGER,max_window INTEGER
      ); CREATE INDEX IF NOT EXISTS observation_import_context ON observation_import_spatial(min_context,min_day,max_day);`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS observation_import_errors (
      identity TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,error TEXT NOT NULL,
      PRIMARY KEY(identity,start,end)
    ) WITHOUT ROWID`);
    read = db.prepare("SELECT key,data FROM observation_chunks WHERE id=?");
    if (version < 4) {
      let after: [string, number, number] | undefined;
      for (;;) {
        // SAVEPOINT rollback invalidates live SQLite iterators. Materialize only
        // one bounded page, then resume by the immutable manifest primary key.
        const rows = after
          ? db
              .prepare(
                "SELECT identity,start,end,chunks FROM observation_imports WHERE (identity,start,end) > (?,?,?) ORDER BY identity,start,end LIMIT 64",
              )
              .all(...after)
          : db
              .prepare(
                "SELECT identity,start,end,chunks FROM observation_imports ORDER BY identity,start,end LIMIT 64",
              )
              .all();
        if (!rows.length) break;
        for (const row of rows) {
          const identity = String(row.identity),
            start = Number(row.start),
            end = Number(row.end);
          db.exec("SAVEPOINT rebuild_import");
          try {
            indexImport(
              identity,
              start,
              end,
              parseManifest(String(row.chunks)),
            );
            db.exec("RELEASE rebuild_import");
          } catch (error) {
            db.exec("ROLLBACK TO rebuild_import; RELEASE rebuild_import");
            if (!(error instanceof ObservationDataError)) throw error;
            // Unknown location must remain discoverable, not become empty coverage.
            // Keep the receipt/original bytes and mark its time window worldwide.
            indexImport(identity, start, end, [], true);
            db.prepare(
              "INSERT OR REPLACE INTO observation_import_errors VALUES(?,?,?,?)",
            ).run(identity, start, end, String(error));
          }
        }
        const last = rows.at(-1)!;
        after = [String(last.identity), Number(last.start), Number(last.end)];
      }
      db.exec("DROP TABLE IF EXISTS observation_import_parts");
      // Older receipts recorded completion, which cannot prove the provider had settled at acquisition.
      if (version < 3) db.exec("UPDATE observation_imports SET recorded=0");
    }
    if (
      !db
        .prepare("PRAGMA table_info(observation_imports)")
        .all()
        .some((c) => c.name === "origins")
    )
      db.exec("ALTER TABLE observation_imports ADD COLUMN origins BLOB");
    if (
      !db
        .prepare("PRAGMA table_info(observation_imports)")
        .all()
        .some((c) => c.name === "legacy")
    )
      db.exec(
        "ALTER TABLE observation_imports ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0",
      );
    // Keep the only surviving ordering evidence. Force revalidation separately;
    // a refresh cannot reconstruct ages of observations already pruned upstream.
    if (version > 0 && version < 7)
      db.exec("UPDATE observation_imports SET legacy=1");
    captures = createCaptureIndex(db);
    db.exec("PRAGMA user_version=7; COMMIT;");
    const quarantined = Number(
      db
        .prepare("SELECT count(*) AS count FROM observation_import_errors")
        .get()!.count,
    );
    if (quarantined)
      console.warn(
        `Observation archive: ${quarantined} historical import(s) need recovery; originals retained and live capture remains available`,
      );
    insert = db.prepare(
      "INSERT INTO observation_chunks(key,start,end,count,data) VALUES(?,?,?,?,?) RETURNING id",
    );
    existing = db.prepare(
      "SELECT id,data,start,end,count FROM observation_chunks WHERE key=?",
    );
    spatial = db.prepare("INSERT INTO observation_spatial VALUES(?,?,?,?,?)");
  } catch (error) {
    db.close();
    throw error;
  }
  function readChunk(
    id: number,
  ):
    | { version: 1; acquisition: Acquisition; points: Observation[] }
    | undefined {
    const row = read.get(id);
    if (!row) return;
    try {
      const bytes = inflateSync(row.data as Uint8Array, {
        maxOutputLength: MAX_CHUNK_BYTES,
      });
      if (createHash("sha256").update(bytes).digest("hex") !== row.key)
        throw new Error("checksum mismatch");
      return JSON.parse(bytes.toString());
    } catch (cause) {
      throw new ObservationDataError(
        `Observation chunk ${id} is unreadable: ${String(cause)}`,
        { cause },
      );
    }
  }
  function readRange(id: number, from: number, to: number) {
    const span = db
      .prepare("SELECT start,end FROM observation_chunks WHERE id=?")
      .get(id);
    if (!span) return undefined;
    if (Number(span.end) < from || Number(span.start) >= to) return null;
    return readChunk(id);
  }
  function indexImport(
    identity: string,
    start: number,
    end: number,
    chunks: readonly number[],
    unknownBounds = false,
  ) {
    db.prepare(
      "INSERT OR IGNORE INTO observation_import_contexts(identity) VALUES(?)",
    ).run(identity);
    const context = Number(
      db
        .prepare("SELECT id FROM observation_import_contexts WHERE identity=?")
        .get(identity)!.id,
    );
    if (context > 2147483647)
      throw new Error("Observation context index exhausted");
    db.prepare(
      "INSERT OR IGNORE INTO observation_import_windows(identity,start,end) VALUES(?,?,?)",
    ).run(identity, start, end);
    const id = db
      .prepare(
        "SELECT id FROM observation_import_windows WHERE identity=? AND start=? AND end=?",
      )
      .get(identity, start, end)!.id;
    if (Number(id) > 2147483647)
      throw new Error("Observation window index exhausted");
    db.prepare("DELETE FROM observation_import_spatial WHERE id=?").run(id);
    db.prepare(
      "DELETE FROM observation_import_errors WHERE identity=? AND start=? AND end=?",
    ).run(identity, start, end);
    const insertBox = (
      west: number,
      east: number,
      south: number,
      north: number,
    ) =>
      db
        .prepare(
          "INSERT INTO observation_import_spatial VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          west,
          east,
          south,
          north,
          context,
          context,
          Math.floor(start / DAY),
          Math.floor((end - 1) / DAY),
          id,
          id,
        );
    if (unknownBounds) {
      insertBox(-180 * SCALE, 180 * SCALE, -90 * SCALE, 90 * SCALE);
      return;
    }
    if (!chunks.length) return;
    // Bounds are derived. Rebuild missing entries from verified originals instead
    // of letting one absent RTree row prevent the entire archive from opening.
    for (const missing of db
      .prepare(
        `SELECT DISTINCT j.value AS id FROM json_each(?) j
      LEFT JOIN observation_spatial s ON s.id=j.value WHERE s.id IS NULL`,
      )
      .all(JSON.stringify(chunks))) {
      const chunkId = Number(missing.id);
      const chunk = readChunk(chunkId);
      if (!chunk || !Array.isArray(chunk.points) || !chunk.points.length)
        throw new ObservationDataError(
          `Missing or empty observation chunk ${chunkId}`,
        );
      let west = Infinity,
        east = -Infinity,
        south = Infinity,
        north = -Infinity;
      for (const point of chunk.points) {
        if (
          !Number.isFinite(point.longitude) ||
          Math.abs(point.longitude) > 180 ||
          !Number.isFinite(point.latitude) ||
          Math.abs(point.latitude) > 90
        )
          throw new ObservationDataError(
            `Invalid bounds in observation chunk ${chunkId}`,
          );
        west = Math.min(west, point.longitude);
        east = Math.max(east, point.longitude);
        south = Math.min(south, point.latitude);
        north = Math.max(north, point.latitude);
      }
      db.prepare("INSERT INTO observation_spatial VALUES(?,?,?,?,?)").run(
        chunkId,
        Math.floor(west * SCALE),
        Math.ceil(east * SCALE),
        Math.floor(south * SCALE),
        Math.ceil(north * SCALE),
      );
    }
    const box = db
      .prepare(
        `SELECT min(s.min_lon) AS west,max(s.max_lon) AS east,
      min(s.min_lat) AS south,max(s.max_lat) AS north,count(*) AS count
      FROM json_each(?) j JOIN observation_spatial s ON s.id=j.value`,
      )
      .get(JSON.stringify(chunks))!;
    if (Number(box.count) !== chunks.length)
      throw new ObservationDataError(
        "Import references missing spatial bounds",
      );
    insertBox(
      Number(box.west),
      Number(box.east),
      Number(box.south),
      Number(box.north),
    );
  }
  return {
    append(
      acquisition: Acquisition,
      points: readonly Observation[],
      batchId?: string,
    ): Chunk {
      if (!points.length || points.length > CHUNK_POINTS)
        throw new Error(
          `Observation chunk must contain 1..${CHUNK_POINTS} points`,
        );
      if (
        !["live", "history-aggregate", "legacy-corrected"].includes(
          acquisition.kind,
        ) ||
        !acquisition.depthPath ||
        !acquisition.settings ||
        typeof acquisition.settings !== "object" ||
        Array.isArray(acquisition.settings)
      )
        throw new Error("Missing observation acquisition context");
      let start = Infinity,
        end = -Infinity;
      let west = Infinity,
        east = -Infinity,
        south = Infinity,
        north = -Infinity;
      for (const p of points) {
        const time = Temporal.Instant.from(p.timestamp).epochMilliseconds;
        if (
          !Number.isFinite(p.longitude) ||
          Math.abs(p.longitude) > 180 ||
          !Number.isFinite(p.latitude) ||
          Math.abs(p.latitude) > 90 ||
          !Number.isFinite(p.depth)
        )
          throw new Error("Invalid observation position or depth");
        if (p.positionTimestamp) Temporal.Instant.from(p.positionTimestamp);
        for (const value of [
          p.headingTrue,
          p.courseOverGroundTrue,
          p.speedOverGround,
        ])
          if (value !== undefined && !Number.isFinite(value))
            throw new Error("Invalid observation heading or speed");
        start = Math.min(start, time);
        end = Math.max(end, time);
        west = Math.min(west, p.longitude);
        east = Math.max(east, p.longitude);
        south = Math.min(south, p.latitude);
        north = Math.max(north, p.latitude);
      }
      const bytes = Buffer.from(
        JSON.stringify(
          { version: 1, acquisition, points, ...(batchId ? { batchId } : {}) },
          (_key, value) => {
            if (
              (typeof value === "number" && !Number.isFinite(value)) ||
              ["function", "symbol", "bigint"].includes(typeof value)
            )
              throw new Error(
                "Observation metadata must be finite JSON values",
              );
            return value;
          },
        ),
      );
      if (bytes.length > MAX_CHUNK_BYTES)
        throw new Error("Observation chunk exceeds size limit");
      const key = createHash("sha256").update(bytes).digest("hex");
      const data = deflateSync(bytes);
      const space = statfsSync(dirname(file));
      if (space.bavail * space.bsize < RESERVE_BYTES + data.length)
        throw new Error(
          "Observation storage reserve reached (256 MiB free required)",
        );
      const ownsTransaction = !db.isTransaction;
      if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
      try {
        const prior = existing.get(key);
        let id = Number(prior?.id);
        if (!id) {
          id = Number(insert.get(key, start, end, points.length, data)!.id);
          spatial.run(
            id,
            Math.floor(west * SCALE),
            Math.ceil(east * SCALE),
            Math.floor(south * SCALE),
            Math.ceil(north * SCALE),
          );
        } else {
          if (
            prior!.start !== start ||
            prior!.end !== end ||
            prior!.count !== points.length
          )
            db.prepare(
              "UPDATE observation_chunks SET start=?,end=?,count=? WHERE id=?",
            ).run(start, end, points.length, id);
          // The content hash proves these exact original bytes belong to this ID.
          // A retry can repair damaged compressed bytes without changing manifests.
          if (!Buffer.from(prior!.data as Uint8Array).equals(data))
            db.prepare("UPDATE observation_chunks SET data=? WHERE id=?").run(
              data,
              id,
            );
          if (
            !db.prepare("SELECT 1 FROM observation_spatial WHERE id=?").get(id)
          )
            spatial.run(
              id,
              Math.floor(west * SCALE),
              Math.ceil(east * SCALE),
              Math.floor(south * SCALE),
              Math.ceil(north * SCALE),
            );
        }
        captures.put(id, acquisition, start, end, [west, south, east, north]);
        if (ownsTransaction) db.exec("COMMIT");
        return { id, key, start, end, count: points.length };
      } catch (error) {
        if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    indexCapturedPage() {
      return captures.migrate(readChunk);
    },
    capturedPageInView(...args: Parameters<typeof captures.page>) {
      return captures.page(...args);
    },
    /** Bounded chunk candidates; exact point filtering follows decompression.
     * Cursor is an ID, so late/out-of-order imports are not missed on continuation. */
    query(
      from: number,
      to: number,
      bounds?: Bounds,
      after = 0,
      limit = 64,
    ): Chunk[] {
      if (
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        to <= from ||
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 128
      )
        throw new Error("Invalid observation query range or limit");
      if (
        bounds &&
        (bounds.some((v) => !Number.isFinite(v)) ||
          Math.abs(bounds[0]) > 180 ||
          Math.abs(bounds[2]) > 180 ||
          Math.abs(bounds[1]) > 90 ||
          Math.abs(bounds[3]) > 90 ||
          bounds[1] > bounds[3])
      )
        throw new Error("Invalid observation query bounds");
      const conditions = "c.id>? AND c.start<? AND c.end>=?";
      if (!bounds)
        return db
          .prepare(
            `SELECT id,key,start,end,count FROM observation_chunks c
        WHERE ${conditions} ORDER BY id LIMIT ?`,
          )
          .all(after, to, from, limit) as unknown as Chunk[];
      const [west, south, east, north] = bounds;
      const longitude =
        west <= east
          ? "s.max_lon>=? AND s.min_lon<=?"
          : "(s.max_lon>=? OR s.min_lon<=?)";
      return db
        .prepare(
          `SELECT c.id,c.key,c.start,c.end,c.count FROM observation_spatial s
        JOIN observation_chunks c ON c.id=s.id
        WHERE ${conditions} AND ${longitude} AND s.max_lat>=? AND s.min_lat<=?
        ORDER BY c.id LIMIT ?`,
        )
        .all(
          after,
          to,
          from,
          Math.floor(west * SCALE),
          Math.ceil(east * SCALE),
          Math.floor(south * SCALE),
          Math.ceil(north * SCALE),
          limit,
        ) as unknown as Chunk[];
    },
    read: readChunk,
    readRange,
    openMergedRead(
      identity: string,
      snapshots: {
        start: number;
        end: number;
        recorded: number;
        chunks: number[];
        stage: AcquisitionStage;
        origins?: Uint8Array;
      }[],
      from: number,
      to: number,
    ) {
      if (mergedReads.size >= 2) throw new ObservationReadBusy();
      if (
        snapshots.length > 4097 ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        to <= from
      )
        throw new ObservationDataError("Invalid owned merged read");
      const merged = new Map<bigint, Observation[]>();
      const candidates = new Map<
        bigint,
        {
          points: Observation[];
          recorded: number;
          stage: AcquisitionStage;
          order: number;
        }[]
      >();
      let remaining = MAX_IMPORT_POINTS * 10;
      snapshots.sort((a, b) => a.start - b.start || a.end - b.end);
      const lo = BigInt(from) * 1000000n,
        hi = BigInt(to) * 1000000n;
      for (const [order, snapshot] of snapshots.entries()) {
        const incoming = new Map<bigint, Observation[]>();
        const origins = new Map(
          (snapshot.origins ? decodeOrigins(snapshot.origins) : []).map(
            ([time, recorded, stage]) => [BigInt(time), { recorded, stage }],
          ),
        );
        for (const id of snapshot.chunks) {
          const chunk = readRange(id, from, to);
          if (chunk === null) continue;
          if (!chunk)
            throw new ObservationDataError(
              `Missing published observation chunk ${id}`,
            );
          if (JSON.stringify(chunk.acquisition) !== identity)
            throw new ObservationDataError(
              `Observation chunk ${id} has incompatible acquisition settings`,
            );
          if ((remaining -= chunk.points.length) < 0)
            throw new ObservationDataError(
              "Owned window exceeds replay work limit",
            );
          for (const point of chunk.points) {
            const time = Temporal.Instant.from(
              point.timestamp,
            ).epochNanoseconds;
            if (time < lo || time >= hi) continue;
            const group = incoming.get(time);
            if (group) group.push(point);
            else incoming.set(time, [point]);
          }
        }
        for (const [time, points] of incoming) {
          const versions = candidates.get(time) ?? [];
          versions.push({
            points,
            order,
            ...(origins.get(time) ?? {
              recorded: snapshot.recorded,
              stage: snapshot.stage,
            }),
          });
          candidates.set(time, versions);
        }
        if (candidates.size > MAX_IMPORT_POINTS)
          throw new ObservationDataError("Owned window exceeds sample limit");
      }
      let count = 0;
      for (const [time, versions] of candidates) {
        versions.sort((a, b) => a.recorded - b.recorded || a.order - b.order);
        let previousStage: AcquisitionStage | undefined;
        for (const version of versions) {
          if (
            version.stage === "preview" &&
            previousStage &&
            previousStage !== "preview"
          )
            continue;
          const previous = merged.get(time);
          mergeObservationGroups(
            merged,
            new Map([[time, version.points]]),
            version.stage,
          );
          if (merged.get(time) !== previous) previousStage = version.stage;
        }
        count += merged.get(time)?.length ?? 0;
        if (count > MAX_IMPORT_POINTS)
          throw new ObservationDataError("Owned window exceeds sample limit");
      }
      const points = [...merged.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .flatMap(([, points]) => points);
      const id = ++nextRead;
      mergedReads.set(id, { points, offset: 0 });
      return id;
    },
    readMergedPage(id: number) {
      const read = mergedReads.get(id);
      if (!read) throw new Error("Unknown owned merged read");
      const points = read.points.slice(read.offset, read.offset + CHUNK_POINTS);
      read.offset += points.length;
      const done = read.offset >= read.points.length;
      if (done) mergedReads.delete(id);
      return { points, done };
    },
    closeMergedRead(id: number) {
      mergedReads.delete(id);
    },
    publishImport(
      identity: string,
      start: number,
      end: number,
      chunks: readonly number[],
      recorded = Date.now(),
      mode: "replace" | "backfill" = "replace",
      stage: AcquisitionStage = "full",
    ) {
      if (
        !identity ||
        !["replace", "backfill"].includes(mode) ||
        !["preview", "partial", "full"].includes(stage) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end <= start ||
        !Number.isSafeInteger(recorded) ||
        chunks.length > Math.ceil(MAX_IMPORT_POINTS / CHUNK_POINTS) ||
        chunks.some((id) => !Number.isSafeInteger(id) || id < 1)
      )
        throw new Error("Invalid observation import receipt");
      db.exec("BEGIN IMMEDIATE");
      try {
        const saved = this.imported(identity, start, end);
        // Another acquisition may have enriched this window while preview was in flight.
        if (stage === "preview" && saved && saved.stage !== "preview") {
          db.exec("COMMIT");
          return;
        }
        const exists = db.prepare(
          "SELECT 1 FROM observation_chunks WHERE id=?",
        );
        if (chunks.some((id) => !exists.get(id)))
          throw new ObservationDataError(
            "Import references a missing observation chunk",
          );
        const previous = mode === "backfill" && saved;
        const origins: ObservationOrigin[] = [];
        if (previous && previous.chunks.length) {
          if (!chunks.length) {
            // Provider retention is not an instruction to delete owned history.
            const savedOrigins = new Map(
              (previous.origins ? decodeOrigins(previous.origins) : []).map(
                (o) => [o[0], o],
              ),
            );
            for (const id of previous.chunks) {
              const chunk = this.read(id);
              if (!chunk)
                throw new ObservationDataError(
                  `Missing published observation chunk ${id}`,
                );
              for (const point of chunk.points) {
                const time = Temporal.Instant.from(
                  point.timestamp,
                ).epochNanoseconds.toString();
                if (!savedOrigins.has(time))
                  savedOrigins.set(time, [
                    time,
                    previous.recorded,
                    previous.stage,
                  ]);
              }
            }
            origins.push(...savedOrigins.values());
            chunks = previous.chunks;
          } else {
            let acquisition: Acquisition | undefined;
            const groups = (ids: readonly number[]) => {
              const result = new Map<bigint, Observation[]>();
              let count = 0;
              for (const id of ids) {
                const chunk = this.read(id);
                if (!chunk)
                  throw new ObservationDataError(
                    `Missing published observation chunk ${id}`,
                  );
                if (chunk.acquisition.kind !== "history-aggregate")
                  throw new ObservationDataError(
                    "Only history aggregates support backfill reconciliation",
                  );
                acquisition ??= chunk.acquisition;
                if (
                  JSON.stringify(acquisition) !==
                  JSON.stringify(chunk.acquisition)
                )
                  throw new ObservationDataError(
                    "Cannot reconcile different acquisition settings",
                  );
                for (const point of chunk.points) {
                  if (++count > MAX_IMPORT_POINTS)
                    throw new ObservationDataError(
                      "Reconciled import exceeds sample limit",
                    );
                  const time = Temporal.Instant.from(
                    point.timestamp,
                  ).epochNanoseconds;
                  const group = result.get(time);
                  if (group) group.push(point);
                  else result.set(time, [point]);
                }
              }
              return result;
            };
            const prior = groups(previous.chunks);
            const merged = new Map(prior);
            mergeObservationGroups(merged, groups(chunks), stage);
            let savedOrigins: Map<string, ObservationOrigin> | undefined;
            for (const [time, group] of prior) {
              if (merged.get(time) !== group) continue;
              // A full replacement of every group needs no old origin metadata.
              // This permits verified reacquisition to repair a damaged blob.
              savedOrigins ??= new Map(
                (previous.origins ? decodeOrigins(previous.origins) : []).map(
                  (o) => [o[0], o],
                ),
              );
              origins.push(
                savedOrigins.get(time.toString()) ?? [
                  time.toString(),
                  previous.recorded,
                  previous.stage,
                ],
              );
            }
            const points = [...merged.entries()]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .flatMap(([, points]) => points);
            if (points.length > MAX_IMPORT_POINTS)
              throw new ObservationDataError(
                "Reconciled import exceeds sample limit",
              );
            const reconciled: number[] = [];
            for (let at = 0; at < points.length; at += CHUNK_POINTS)
              reconciled.push(
                this.append(acquisition!, points.slice(at, at + CHUNK_POINTS))
                  .id,
              );
            chunks = reconciled;
          }
        }
        db.prepare(
          `INSERT INTO observation_imports(identity,start,end,recorded,chunks,stage,origins) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(identity,start,end) DO UPDATE SET recorded=excluded.recorded,chunks=excluded.chunks,stage=excluded.stage,origins=excluded.origins,legacy=0`,
        ).run(
          identity,
          start,
          end,
          recorded,
          JSON.stringify(chunks),
          stage,
          encodeOrigins(origins),
        );
        indexImport(identity, start, end, chunks);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Completed reads expire for freshness; old manifests remain available for offline display. */
    imported(
      identity: string,
      start: number,
      end: number,
      now = Date.now(),
    ):
      | {
          recorded: number;
          chunks: number[];
          fresh: boolean;
          stage: AcquisitionStage;
          origins?: Uint8Array;
        }
      | undefined {
      const row = db
        .prepare(
          "SELECT recorded,chunks,stage,origins,legacy FROM observation_imports WHERE identity=? AND start=? AND end=?",
        )
        .get(identity, start, end);
      if (!row) return;
      const recorded = Number(row.recorded),
        chunks = parseManifest(String(row.chunks));
      const age = now - recorded;
      return {
        recorded,
        chunks,
        stage: row.stage as AcquisitionStage,
        ...(row.origins ? { origins: row.origins as Uint8Array } : {}),
        fresh:
          !row.legacy &&
          age >= 0 &&
          age < (chunks.length && row.stage === "full" ? 86400000 : 300000),
      };
    },
    /** Spatial hints include only the currently published version of each import. */
    importedInView(
      identity: string,
      from: number,
      to: number,
      bounds: Bounds,
    ): { start: number; end: number }[] {
      return this.importedPageInView(identity, from, to, bounds).windows;
    },
    importedPageInView(
      identity: string,
      from: number,
      to: number,
      bounds: Bounds,
      before?: number,
    ): { windows: { start: number; end: number }[]; before?: number } {
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
          (!Number.isSafeInteger(before) || before < 1 || before > 2147483648))
      )
        throw new Error("Invalid imported observation viewport");
      const context = db
        .prepare("SELECT id FROM observation_import_contexts WHERE identity=?")
        .get(identity)?.id;
      if (context === undefined) return { windows: [] };
      // CROSS JOIN fixes the spatial index as the outer loop. Sorting all matches would
      // turn a bounded hint read into a whole-archive scan in dense anchorages.
      const query =
        db.prepare(`SELECT w.start,w.end FROM observation_import_spatial s
        CROSS JOIN observation_import_windows w ON w.id=s.id
        WHERE s.min_context<=? AND s.max_context>=? AND s.min_day<=? AND s.max_day>=?
          AND s.max_lon>=? AND s.min_lon<=? AND s.max_lat>=? AND s.min_lat<=?
          AND w.start<? AND w.end>? AND s.min_window<? AND s.max_window>? LIMIT 65`);
      let upper =
        before ??
        Number(
          db
            .prepare(
              "SELECT coalesce(max(id),0)+1 AS next FROM observation_import_windows",
            )
            .get()!.next,
        );
      let lower = 0;
      // Bisect indexed ID ranges until the whole matching range fits. The cursor
      // skips that complete range, rather than repeatedly returning finished windows.
      for (let attempt = 0; attempt < 64; attempt++) {
        const found = new Map<string, { start: number; end: number }>();
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
            to,
            from,
            upper,
            lower,
          ) as unknown as { start: number; end: number }[];
          for (const row of rows) found.set(`${row.start}/${row.end}`, row);
        }
        if (found.size > 64) {
          lower = Math.floor((lower + upper) / 2);
        } else if (!found.size && lower > 0) {
          upper = lower + 1;
          lower = 0;
        } else
          return {
            windows: [...found.values()].sort(
              (a, b) => b.start - a.start || b.end - a.end,
            ),
            ...(lower > 0 ? { before: lower + 1 } : {}),
          };
      }
      throw new Error("Observation viewport paging exceeded its work budget");
    },
    close() {
      mergedReads.clear();
      db.close();
    },
  };
}
