import { DatabaseSync } from "node:sqlite";
import {
  MIN_ZOOM,
  TileCells,
  TileStore,
  decodeTile,
  encodeTile,
  mergeCell,
  minPoolTile,
} from "./core/index.js";

/**
 * The derived, gridded store the chart reads from, in the plugin's own database
 * (tables created by a migration in storage.ts). It sits beside the raw
 * `bathymetry` sounding log, which stays the source of what is shared; this is
 * the fast spatial index built from the same soundings.
 *
 * One row per tile per level. Coarser levels are the min-pooled parents of the
 * base level, so a bounding-box read at the zoom-appropriate level is a handful
 * of keyed lookups, with no scanning or interpolation at query time.
 *
 * Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
 */
export function createTileStore(db: DatabaseSync): TileStore {
  const readStmt = db.prepare(
    "SELECT cells FROM tiles WHERE z = ? AND x = ? AND y = ?",
  );
  const writeStmt = db.prepare(
    `INSERT INTO tiles(z, x, y, cells, updated) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(z, x, y) DO UPDATE SET cells = excluded.cells, updated = excluded.updated`,
  );
  const deleteStmt = db.prepare(
    "DELETE FROM tiles WHERE z = ? AND x = ? AND y = ?",
  );
  const getMetaStmt = db.prepare("SELECT value FROM tile_meta WHERE key = ?");
  const listStmt = db.prepare("SELECT x, y FROM tiles WHERE z = ?");
  const setMetaStmt = db.prepare(
    `INSERT INTO tile_meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const read = (z: number, x: number, y: number): TileCells | undefined => {
    const row = readStmt.get(z, x, y) as { cells: Uint8Array } | undefined;
    return row ? decodeTile(row.cells) : undefined;
  };

  const write = (z: number, x: number, y: number, cells: TileCells): void => {
    if (cells.size === 0) {
      deleteStmt.run(z, x, y);
      return;
    }
    writeStmt.run(z, x, y, encodeTile(cells), Date.now());
  };

  const merge = (
    z: number,
    x: number,
    y: number,
    incoming: TileCells,
  ): void => {
    const cells = read(z, x, y) ?? new Map();
    for (const [key, cell] of incoming) {
      mergeCell(cells, key, cell.depth, cell.count);
    }
    write(z, x, y, cells);
  };

  const updateAncestors = (z: number, x: number, y: number): void => {
    let lz = z;
    let lx = x;
    let ly = y;
    while (lz > MIN_ZOOM) {
      const pz = lz - 1;
      const px = lx >> 1;
      const py = ly >> 1;
      const children = [
        read(lz, px * 2, py * 2),
        read(lz, px * 2 + 1, py * 2),
        read(lz, px * 2, py * 2 + 1),
        read(lz, px * 2 + 1, py * 2 + 1),
      ];
      write(pz, px, py, minPoolTile(children));
      lz = pz;
      lx = px;
      ly = py;
    }
  };

  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore, don't mask the original error
      }
      throw err;
    }
  };

  return {
    read,
    write,
    merge,
    updateAncestors,
    listTiles: (z) => listStmt.all(z) as { x: number; y: number }[],
    getMeta: (key) =>
      (getMetaStmt.get(key) as { value: string } | undefined)?.value,
    setMeta: (key, value) => {
      setMetaStmt.run(key, value);
    },
    transaction,
    clear: () => {
      db.exec("DELETE FROM tiles");
    },
    // The database belongs to the plugin, which outlives this store.
    close: () => {},
  };
}
