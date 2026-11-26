import type { DatabaseSync } from "node:sqlite";
import { DEFINITIONS } from "./geometry.js";
const MAX_PUBLISHED_DEPTH_M = DEFINITIONS.cells.max_published_depth_m;

const SCALE = 10_000_000;
// Bump when id encoding, index dimensions or trigger semantics change.
const VERSION = JSON.stringify([2, SCALE, MAX_PUBLISHED_DEPTH_M]);
const covered = (time: string) => `EXISTS(SELECT 1 FROM refined_windows
  WHERE start BETWEEN ${time}-COALESCE((SELECT CAST(value AS INTEGER) FROM preview_meta WHERE key='window_span'),0) AND ${time}
    AND end>${time})`;
const id = (prefix: string) =>
  `(${prefix}py+1000000)*4000000+${prefix}px+2000000`;
const epoch =
  "COALESCE((SELECT CAST(value AS INTEGER) FROM tile_meta WHERE key='preview_epoch'),0)";
const mark = (
  prefix: string,
) => `CASE WHEN ${prefix}depth>=${MAX_PUBLISHED_DEPTH_M} THEN 2147483647
  WHEN ${covered(`${prefix}time`)}
  THEN ${epoch}+1 ELSE ${epoch} END`;
const values = (prefix: string) => `${id(prefix)},
  CAST(${prefix}lon*${SCALE} AS INTEGER)-1,CAST(${prefix}lon*${SCALE} AS INTEGER)+1,
  CAST(${prefix}lat*${SCALE} AS INTEGER)-1,CAST(${prefix}lat*${SCALE} AS INTEGER)+1,
  ${mark(prefix)},${mark(prefix)},CAST(${prefix}time/60000 AS INTEGER),CAST(${prefix}time/60000 AS INTEGER)`;

/** Quarantine a derived index without editing its shadow tables or canonical data. */
export function disablePreviewSpatial(db: DatabaseSync, reason: string) {
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN IMMEDIATE");
  try {
    for (const suffix of [
      "insert",
      "update",
      "delete",
      "refined",
      "unrefined",
      "span",
    ])
      db.exec(`DROP TRIGGER IF EXISTS preview_spatial_${suffix}`);
    db.exec(
      "DELETE FROM preview_meta WHERE key IN ('spatial_version','spatial_ready','spatial_cursor','window_span')",
    );
    db.prepare(
      "INSERT OR REPLACE INTO preview_meta VALUES('spatial_unavailable',?)",
    ).run(reason);
    if (own) db.exec("COMMIT");
  } catch (error) {
    if (own) db.exec("ROLLBACK");
    throw error;
  }
}

/** Called after a failed write rolls back. Never hide damage to some
 * other table: confirm that the disposable preview tree is the broken one. */
export function isolateDamagedPreview(
  db: DatabaseSync,
  error: unknown,
): boolean {
  if (![11, 267].includes((error as { errcode: number })?.errcode))
    return false;
  try {
    if (
      db.prepare("SELECT rtreecheck('preview_spatial') AS result").get()
        ?.result === "ok"
    )
      return false;
  } catch (check) {
    if (![11, 267].includes((check as { errcode: number }).errcode))
      return false;
  }
  disablePreviewSpatial(db, String(error));
  return true;
}

/** A changed sensor configuration invalidates this disposable preview cache.
 * Drop its derived tree in bulk instead of running one deletion trigger per cell. */
function dropPreviewSpatial(db: DatabaseSync) {
  db.exec(`DROP TRIGGER IF EXISTS preview_spatial_insert;
    DROP TRIGGER IF EXISTS preview_spatial_update;
    DROP TRIGGER IF EXISTS preview_spatial_delete;
    DROP TRIGGER IF EXISTS preview_spatial_refined;
    DROP TRIGGER IF EXISTS preview_spatial_unrefined;
    DROP TRIGGER IF EXISTS preview_spatial_span;
    DROP TABLE IF EXISTS preview_spatial;
    DROP TABLE IF EXISTS preview_times;`);
}
export function clearPreviewSpatial(db: DatabaseSync) {
  dropPreviewSpatial(db);
  db.exec("DELETE FROM preview_cells; DELETE FROM preview_windows;");
  createPreviewSpatial(db);
}

/** The R*Tree's third dimension excludes completed QC windows before LIMIT is
 * applied. A new epoch makes all old evidence provisional without rewriting it. */
function initializePreviewSpatial(db: DatabaseSync) {
  if (
    db
      .prepare("SELECT value FROM preview_meta WHERE key='spatial_version'")
      .get()?.value !== VERSION
  )
    dropPreviewSpatial(db);
  const existed = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='preview_spatial'")
    .get();
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS preview_spatial USING rtree_i32(
    id,west,east,south,north,pending_min,pending_max,time_min,time_max);
    CREATE TABLE IF NOT EXISTS preview_times(time INTEGER NOT NULL,id INTEGER NOT NULL,
      PRIMARY KEY(time,id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS refined_windows(start INTEGER NOT NULL,end INTEGER NOT NULL,
      PRIMARY KEY(start,end)) WITHOUT ROWID;
    INSERT OR IGNORE INTO preview_meta SELECT 'window_span',(SELECT COALESCE(MAX(end-start),0) FROM refined_windows)
      WHERE NOT EXISTS(SELECT 1 FROM preview_meta WHERE key='window_span');
    CREATE TRIGGER IF NOT EXISTS preview_spatial_span BEFORE INSERT ON refined_windows BEGIN
      UPDATE preview_meta SET value=MAX(CAST(value AS INTEGER),new.end-new.start) WHERE key='window_span'; END;
    CREATE TRIGGER IF NOT EXISTS preview_spatial_insert AFTER INSERT ON preview_cells BEGIN
      INSERT OR REPLACE INTO preview_spatial VALUES(${values("new.")});
      INSERT OR REPLACE INTO preview_times VALUES(new.time,${id("new.")}); END;
    CREATE TRIGGER IF NOT EXISTS preview_spatial_update AFTER UPDATE ON preview_cells BEGIN
      DELETE FROM preview_spatial WHERE id=${id("old.")};
      DELETE FROM preview_times WHERE time=old.time AND id=${id("old.")};
      INSERT OR REPLACE INTO preview_spatial VALUES(${values("new.")});
      INSERT OR REPLACE INTO preview_times VALUES(new.time,${id("new.")}); END;
    CREATE TRIGGER IF NOT EXISTS preview_spatial_delete AFTER DELETE ON preview_cells BEGIN
      DELETE FROM preview_spatial WHERE id=${id("old.")};
      DELETE FROM preview_times WHERE time=old.time AND id=${id("old.")}; END;
    CREATE TRIGGER IF NOT EXISTS preview_spatial_refined AFTER INSERT ON refined_windows BEGIN
      UPDATE preview_spatial SET pending_min=${epoch}+1,pending_max=${epoch}+1
      WHERE pending_min<=${epoch} AND id IN
        (SELECT id FROM preview_times WHERE time>=new.start AND time<new.end);
    END;
    CREATE TRIGGER IF NOT EXISTS preview_spatial_unrefined AFTER DELETE ON refined_windows
    WHEN COALESCE((SELECT value FROM tile_meta WHERE key='preview_resetting'),'0')!='1' BEGIN
      UPDATE preview_spatial SET pending_min=${epoch},pending_max=${epoch}
      WHERE pending_min=${epoch}+1 AND id IN
        (SELECT id FROM preview_times p WHERE time>=old.start AND time<old.end
            AND NOT ${covered("p.time")});
    END;`);
  if (!existed)
    db.exec(
      "DELETE FROM preview_times; DELETE FROM preview_meta WHERE key IN ('spatial_cursor','spatial_ready')",
    );
  if (!db.prepare("SELECT 1 FROM preview_cells LIMIT 1").get())
    db.exec("INSERT OR REPLACE INTO preview_meta VALUES('spatial_ready','1')");
  db.prepare(
    "INSERT OR REPLACE INTO preview_meta VALUES('spatial_version',?)",
  ).run(VERSION);
}

export function createPreviewSpatial(db: DatabaseSync) {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    initializePreviewSpatial(db);
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction) db.exec("ROLLBACK");
    throw error;
  }
  const meta = db.prepare("SELECT value FROM preview_meta WHERE key=?");
  const put = db.prepare("INSERT OR REPLACE INTO preview_meta VALUES(?,?)");
  const page = db.prepare(
    "SELECT py,px FROM preview_cells WHERE (py,px)>(?,?) ORDER BY py,px LIMIT 500",
  );
  const copy = db.prepare(
    `INSERT OR REPLACE INTO preview_spatial SELECT ${values("")} FROM preview_cells WHERE py=? AND px=?`,
  );
  const copyTime = db.prepare(`INSERT OR REPLACE INTO preview_times
    SELECT time,${id("")} FROM preview_cells WHERE py=? AND px=?`);
  return {
    ready: () => meta.get("spatial_ready")?.value === "1",
    prioritize(generation: string, rows: { py: number; px: number }[]) {
      if (!rows.length) return;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (meta.get("generation")?.value === generation)
          for (const p of rows) {
            copy.run(p.py, p.px);
            copyTime.run(p.py, p.px);
          }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Only a migration worker calls this on file databases. Each batch yields
     * its write lock; normal ingestion maintains the index through triggers. */
    fill(generation: string): boolean {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          meta.get("generation")?.value !== generation ||
          meta.get("spatial_ready")?.value === "1"
        ) {
          db.exec("COMMIT");
          return true;
        }
        let saved: unknown;
        try {
          saved = JSON.parse(String(meta.get("spatial_cursor")?.value));
        } catch {}
        // The cursor is disposable: replaying indexed rows is safe after damage
        // or an older cursor format, whereas retrying invalid JSON never progresses.
        const cursor =
          Array.isArray(saved) &&
          saved.length === 2 &&
          saved.every(Number.isInteger) &&
          Math.abs(saved[0]) <= 1_000_000 &&
          Math.abs(saved[1]) <= 2_000_000
            ? saved
            : [-1_000_000, -2_000_000];
        const rows = page.all(...cursor) as { py: number; px: number }[];
        for (const p of rows) {
          copy.run(p.py, p.px);
          copyTime.run(p.py, p.px);
        }
        if (rows.length)
          put.run(
            "spatial_cursor",
            JSON.stringify([rows.at(-1)!.py, rows.at(-1)!.px]),
          );
        const done = rows.length < 500;
        if (done) put.run("spatial_ready", "1");
        db.exec("COMMIT");
        return done;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** Invalidating QC coverage is O(1) in the spatial index. Called in the same
 * transaction that clears refined_windows, so readers never mix generations. */
export function resetPreviewSpatial(db: DatabaseSync, clear: () => void) {
  db.exec(`INSERT INTO tile_meta(key,value) VALUES('preview_epoch','2')
    ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+2;
    INSERT OR REPLACE INTO tile_meta VALUES('preview_resetting','1')`);
  try {
    clear();
  } finally {
    db.exec("INSERT OR REPLACE INTO tile_meta VALUES('preview_resetting','0')");
  }
}

export function spatialPreviewQuery(db: DatabaseSync) {
  const query = db.prepare(`SELECT p.py,p.px,p.lon,p.lat,p.depth,p.time
    FROM preview_spatial r JOIN preview_cells p
      ON p.py=(r.id/4000000)-1000000 AND p.px=(r.id%4000000)-2000000
    WHERE r.west<=? AND r.east>=? AND r.south<=? AND r.north>=?
      AND r.pending_min<=${epoch} AND r.time_max>=? AND p.time>=? AND p.time<? LIMIT ?`);
  return (
    west: number,
    south: number,
    east: number,
    north: number,
    since: number,
    limit: number,
    until = Number.MAX_SAFE_INTEGER,
  ) =>
    query.all(
      Math.ceil(east * SCALE),
      Math.floor(west * SCALE),
      Math.ceil(north * SCALE),
      Math.floor(south * SCALE),
      Math.floor(since / 60000),
      since,
      until,
      limit,
    );
}
