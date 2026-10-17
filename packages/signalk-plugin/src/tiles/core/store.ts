// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
/**
 * The tile-store interface shared by both sides, plus an in-memory
 * implementation.
 *
 * The plugin backs it with SQLite; the chart client keeps the tiles
 * in a `Map` for its own live soundings, reset as it refetches tiles. The
 * shared {@link createTileAccumulator} and {@link minPoolTile} logic works
 * against this interface so both build identical tiles.
 */

import { MIN_ZOOM, TileCells, minPoolTile } from "./grid.js";

export interface TileStore {
  /** A tile's cells, or undefined when it holds no soundings. */
  read(z: number, x: number, y: number): TileCells | undefined;
  /** Replace a tile (deletes it when empty). */
  write(z: number, x: number, y: number, cells: TileCells): void;
  /** Merge cells into a tile, keeping the shallowest depth and summing counts. */
  merge(z: number, x: number, y: number, incoming: TileCells): void;
  /** Rebuild every ancestor of a changed base tile, up to {@link MIN_ZOOM}. */
  updateAncestors(z: number, x: number, y: number): void;
  /** Every occupied tile at a level (for a bulk pyramid rebuild). */
  listTiles(z: number): { x: number; y: number }[];
  /** Read a store-level key. */
  getMeta(key: string): string | undefined;
  /** Write a store-level key. */
  setMeta(key: string, value: string): void;
  /** Run `fn` inside a single transaction (a no-op batch on the client). */
  transaction<T>(fn: () => T): T;
  /** Drop every tile. */
  clear(): void;
  /** Release any resources (a no-op for the in-memory store). */
  close(): void;
}

export function createMemoryTileStore(): TileStore {
  const tiles = new Map<string, TileCells>();
  const meta = new Map<string, string>();
  const key = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

  const read = (z: number, x: number, y: number) => tiles.get(key(z, x, y));

  const write = (z: number, x: number, y: number, cells: TileCells): void => {
    if (cells.size === 0) {
      tiles.delete(key(z, x, y));
      return;
    }
    tiles.set(key(z, x, y), cells);
  };

  const merge = (
    z: number,
    x: number,
    y: number,
    incoming: TileCells,
  ): void => {
    const cells = read(z, x, y) ?? new Map();
    for (const [k, cell] of incoming) {
      const existing = cells.get(k);
      if (!existing) {
        cells.set(k, { depth: cell.depth, count: cell.count });
      } else {
        if (cell.depth < existing.depth) existing.depth = cell.depth;
        existing.count = Math.min(255, existing.count + cell.count);
      }
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

  return {
    read,
    write,
    merge,
    updateAncestors,
    listTiles: (z) => {
      const out: { x: number; y: number }[] = [];
      for (const key of tiles.keys()) {
        const [tz, tx, ty] = key.split("/");
        if (Number(tz) === z) {
          out.push({ x: Number(tx), y: Number(ty) });
        }
      }
      return out;
    },
    getMeta: (k) => meta.get(k),
    setMeta: (k, v) => {
      meta.set(k, v);
    },
    transaction: (fn) => fn(),
    clear: () => {
      tiles.clear();
    },
    close: () => {
      tiles.clear();
    },
  };
}
