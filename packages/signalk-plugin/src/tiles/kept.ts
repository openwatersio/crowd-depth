import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { keptTileSchema } from "../storage.js";
import {
  cellRanges,
  M_PER_DEG_LAT,
  mPerDegLon,
  tileBounds,
} from "./geometry.js";
import { MARGIN_M, sharedTile, type Detail } from "./surface.js";

/** Bytes of encoded tiles kept on disk, beside the cells: a few views at every zoom
 * on a busy store. The oldest built go first. */
export const KEPT_BYTES = 64 * 1024 * 1024;
const VERSION_KEY = "kept_tiles_version";

/** The box a tile is built from, in degrees: that of the ancestor whose surface it's
 * cut from, or with `own` its own, and the surface's margin. */
export function tileReach(z: number, x: number, y: number, own = false) {
  const a = own ? { z, x, y } : sharedTile(z, x, y);
  const b = tileBounds(a.z, a.x, a.y);
  const lat = Math.max(Math.abs(b.north), Math.abs(b.south));
  const dLat = MARGIN_M / M_PER_DEG_LAT;
  const dLon = MARGIN_M / mPerDegLon(Math.min(lat, 85));
  return {
    west: b.west - dLon,
    south: b.south - dLat,
    east: b.east + dLon,
    north: b.north + dLat,
  };
}

/** Bytes each kept row is counted as besides its tile: its key, index entries and
 * boxes. So empty tiles count toward the bound too. */
const ROW_BYTES = 256;

/** The installed version of a dependency, found as Node finds it from `dir`. */
function installed(dir: string, name: string): string {
  for (let d = dir; ; d = dirname(d)) {
    try {
      return JSON.parse(
        readFileSync(join(d, "node_modules", name, "package.json"), "utf8"),
      ).version;
    } catch {
      if (dirname(d) === d) return "";
    }
  }
}

/**
 * What tiles are drawn with: the tile code, the grid's definitions and the installed
 * versions of the plugin's dependencies, as this build has them. A tile kept by
 * another build is built again, so a change to how tiles are drawn shows without
 * anyone remembering to bump a number.
 */
function drawnBy(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const hash = createHash("sha256");
  for (const f of readdirSync(here).sort()) {
    if (/\.(js|ts)$/.test(f) && !f.endsWith(".d.ts")) {
      hash.update(f).update(readFileSync(join(here, f)));
    }
  }
  hash.update(readFileSync(join(here, "..", "definitions.json")));
  const pkg = JSON.parse(
    readFileSync(join(here, "..", "..", "package.json"), "utf8"),
  );
  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
    hash.update(`${name}@${installed(here, name)}`);
  }
  return hash.digest("hex").slice(0, 16);
}

export type KeptTiles = ReturnType<typeof createKeptTiles>;

/**
 * Encoded tiles kept in the plugin's database (tables and triggers made here, by
 * keptTileSchema in storage.ts), so tiles built once are read back after a restart, and memory holds
 * only the few most used.
 *
 * A tile is reserved before it's built, as a row with no tile and its boxes, the cells
 * it's built from. Any write under a box drops the row, from any connection, so a build
 * that read the cells before a write finds its row gone and isn't kept. An empty tile,
 * where the boat has no soundings, is kept as an empty blob.
 */
export function createKeptTiles(
  db: DatabaseSync,
  detail: Detail,
  { maxBytes = KEPT_BYTES, version = drawnBy() } = {},
) {
  // Throws where they can't be made, leaving the database without them.
  keptTileSchema(db);
  const getVersion = db.prepare("SELECT value FROM tile_meta WHERE key = ?");
  if (
    (getVersion.get(VERSION_KEY) as { value: string } | undefined)?.value !==
    version
  ) {
    // The boxes first, so the trigger finds none to drop.
    db.exec(
      "DELETE FROM kept_tile_boxes; DELETE FROM kept_tile_box_owners; DELETE FROM kept_tiles;",
    );
    db.prepare(
      `INSERT INTO tile_meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(VERSION_KEY, version);
  }
  // Reserved by a start that stopped before its builds came back, and any boxes left
  // without a tile.
  db.exec(`
    DELETE FROM kept_tiles WHERE tile IS NULL;
    DELETE FROM kept_tile_box_owners WHERE tile NOT IN (SELECT id FROM kept_tiles);
    DELETE FROM kept_tile_boxes
    WHERE id NOT IN (SELECT box FROM kept_tile_box_owners);`);

  const read = db.prepare(
    `SELECT tile FROM kept_tiles
     WHERE z = ? AND x = ? AND y = ? AND detail = ? AND tile IS NOT NULL`,
  );
  // A tile reserved again drops its row first, so the trigger takes its boxes: a
  // REPLACE wouldn't fire it.
  const unreserve = db.prepare(
    "DELETE FROM kept_tiles WHERE z = ? AND x = ? AND y = ? AND detail = ?",
  );
  const reserveTile = db.prepare(
    `INSERT INTO kept_tiles(z, x, y, detail, tile) VALUES(?, ?, ?, ?, NULL)
     RETURNING id`,
  );
  const addBox = db.prepare(
    "INSERT INTO kept_tile_boxes(py0, py1, px0, px1) VALUES(?, ?, ?, ?)",
  );
  const addOwner = db.prepare(
    "INSERT INTO kept_tile_box_owners(box, tile) VALUES(?, ?)",
  );
  const fillTile = db.prepare(
    "UPDATE kept_tiles SET tile = ? WHERE id = ? AND tile IS NULL",
  );
  const total = db.prepare(
    `SELECT total(length(tile)) + ${ROW_BYTES} * count(*) AS n FROM kept_tiles`,
  );
  const oldest = db.prepare(
    `SELECT id, ifnull(length(tile), 0) + ${ROW_BYTES} AS n FROM kept_tiles ORDER BY id`,
  );
  const dropThrough = db.prepare("DELETE FROM kept_tiles WHERE id <= ?");

  // Bytes kept, at most: rows the triggers drop aren't counted off.
  let bytes = (total.get() as { n: number }).n;

  const transaction = (fn: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Don't mask the original error.
      }
      throw err;
    }
  };

  /** Drop the oldest tiles to an eighth under the bound, so it isn't done every time. */
  const evict = () => {
    bytes = (total.get() as { n: number }).n;
    if (bytes <= maxBytes) return;
    let over = bytes - (maxBytes * 7) / 8;
    let last: number | undefined;
    for (const row of oldest.iterate() as Iterable<{ id: number; n: number }>) {
      last = row.id;
      over -= row.n;
      bytes -= row.n;
      if (over <= 0) break;
    }
    if (last === undefined) return;
    dropThrough.run(last);
  };

  return {
    /** A kept tile: its encoded MVT, null where the boat has no soundings, or
     * undefined where none is kept. */
    get(z: number, x: number, y: number): Buffer | null | undefined {
      const row = read.get(z, x, y, detail) as { tile: Uint8Array } | undefined;
      if (!row) return undefined;
      return row.tile.length ? Buffer.from(row.tile) : null;
    },

    /** Reserve a tile about to be built; returns the id to keep it by. */
    reserve(z: number, x: number, y: number): number {
      let id = 0;
      const r = tileReach(z, x, y);
      transaction(() => {
        unreserve.run(z, x, y, detail);
        ({ id } = reserveTile.get(z, x, y, detail) as { id: number });
        for (const b of cellRanges(r.west, r.south, r.east, r.north)) {
          const box = addBox.run(b.py0, b.py1, b.px0, b.px1).lastInsertRowid;
          addOwner.run(box, id);
        }
      });
      return id;
    },

    /** Keep a reserved tile, unless a write under it dropped its reservation. */
    keep(id: number, tile: Buffer | undefined) {
      const n = (tile?.length ?? 0) + ROW_BYTES;
      if (Number(fillTile.run(tile ?? new Uint8Array(0), id).changes) === 0) {
        return;
      }
      bytes += n;
      if (bytes > maxBytes) evict();
    },
  };
}
