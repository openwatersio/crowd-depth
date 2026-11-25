import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
}

export interface Acquisition {
  kind: "live" | "history-aggregate" | "legacy-corrected";
  depthPath: string;
  /** Exact saved acquisition/calibration settings, not proof of actual source. */
  settings: Record<string, unknown>;
}

export const CHUNK_POINTS = 512;
export const MAX_IMPORT_POINTS = 100000;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const SCALE = 1e7;
const RESERVE_BYTES = 256 * 1024 * 1024;
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
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    const version = Number(
      db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version !== 0 && version !== 1 && version !== 2)
      throw new Error(`Unsupported observation store version ${version}`);
    db.exec(`BEGIN IMMEDIATE;
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
    CREATE TABLE IF NOT EXISTS observation_import_parts (
      identity TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
      part INTEGER NOT NULL, chunk INTEGER NOT NULL,
      PRIMARY KEY(identity,start,end,part)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS observation_import_part_chunk ON observation_import_parts(chunk);
    `);
    if (version < 2)
      db.exec(`INSERT INTO observation_import_parts
        SELECT i.identity,i.start,i.end,j.key,j.value
        FROM observation_imports i, json_each(i.chunks) j;`);
    db.exec("PRAGMA user_version=2; COMMIT;");
  } catch (error) {
    db.close();
    throw error;
  }
  const insert = db.prepare(
    "INSERT INTO observation_chunks(key,start,end,count,data) VALUES(?,?,?,?,?) RETURNING id",
  );
  const existing = db.prepare("SELECT id FROM observation_chunks WHERE key=?");
  const spatial = db.prepare(
    "INSERT INTO observation_spatial VALUES(?,?,?,?,?)",
  );
  const read = db.prepare("SELECT key,data FROM observation_chunks WHERE id=?");
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
      db.exec("BEGIN IMMEDIATE");
      try {
        let id = Number(existing.get(key)?.id);
        if (!id) {
          id = Number(insert.get(key, start, end, points.length, data)!.id);
          spatial.run(
            id,
            Math.floor(west * SCALE),
            Math.ceil(east * SCALE),
            Math.floor(south * SCALE),
            Math.ceil(north * SCALE),
          );
        }
        db.exec("COMMIT");
        return { id, key, start, end, count: points.length };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
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
    read(
      id: number,
    ):
      | { version: 1; acquisition: Acquisition; points: Observation[] }
      | undefined {
      const row = read.get(id);
      if (!row) return;
      const bytes = inflateSync(row.data as Uint8Array, {
        maxOutputLength: MAX_CHUNK_BYTES,
      });
      if (createHash("sha256").update(bytes).digest("hex") !== row.key)
        throw new Error(`Observation chunk ${id} checksum mismatch`);
      return JSON.parse(bytes.toString());
    },
    publishImport(
      identity: string,
      start: number,
      end: number,
      chunks: readonly number[],
      recorded = Date.now(),
    ) {
      if (
        !identity ||
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
        const exists = db.prepare(
          "SELECT 1 FROM observation_chunks WHERE id=?",
        );
        if (chunks.some((id) => !exists.get(id)))
          throw new Error("Import references a missing observation chunk");
        db.prepare(
          `INSERT INTO observation_imports VALUES(?,?,?,?,?)
          ON CONFLICT(identity,start,end) DO UPDATE SET recorded=excluded.recorded,chunks=excluded.chunks`,
        ).run(identity, start, end, recorded, JSON.stringify(chunks));
        db.prepare(
          "DELETE FROM observation_import_parts WHERE identity=? AND start=? AND end=?",
        ).run(identity, start, end);
        const part = db.prepare(
          "INSERT INTO observation_import_parts VALUES(?,?,?,?,?)",
        );
        chunks.forEach((id, n) => part.run(identity, start, end, n, id));
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
    ): { recorded: number; chunks: number[]; fresh: boolean } | undefined {
      const row = db
        .prepare(
          "SELECT recorded,chunks FROM observation_imports WHERE identity=? AND start=? AND end=?",
        )
        .get(identity, start, end);
      if (!row) return;
      const recorded = Number(row.recorded),
        chunks = JSON.parse(String(row.chunks)) as number[];
      const age = now - recorded;
      return {
        recorded,
        chunks,
        fresh: age >= 0 && age < (chunks.length ? 86400000 : 300000),
      };
    },
    /** Spatial hints include only the currently published version of each import. */
    importedInView(
      identity: string,
      from: number,
      to: number,
      bounds: Bounds,
    ): { start: number; end: number }[] {
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
        south > north
      )
        throw new Error("Invalid imported observation viewport");
      const longitude =
        west <= east
          ? "s.max_lon>=? AND s.min_lon<=?"
          : "(s.max_lon>=? OR s.min_lon<=?)";
      return db
        .prepare(
          `SELECT DISTINCT p.start,p.end FROM observation_spatial s
        JOIN observation_import_parts p ON p.chunk=s.id
        WHERE p.identity=? AND p.start<? AND p.end>? AND ${longitude}
          AND s.max_lat>=? AND s.min_lat<=?
        ORDER BY p.start DESC,p.end DESC LIMIT 64`,
        )
        .all(
          identity,
          to,
          from,
          Math.floor(west * SCALE),
          Math.ceil(east * SCALE),
          Math.floor(south * SCALE),
          Math.ceil(north * SCALE),
        ) as unknown as { start: number; end: number }[];
    },
    close() {
      db.close();
    },
  };
}
