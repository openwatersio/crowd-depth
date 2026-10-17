// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
/**
 * Folds soundings into the base-level tiles and, on
 * {@link TileAccumulator.flush}, writes the changed tiles and min-pools their
 * ancestors.
 *
 * Shared by the plugin and the chart client, so both build
 * identical tiles from the same live stream. Batched so many soundings become
 * one transaction; used by the live writer and any bulk load.
 */

import { Sounding } from "./types.js";
import {
  BASE_ZOOM,
  MIN_ZOOM,
  TILE_SIZE,
  TileCells,
  encodeDepth,
  lngLatToCell,
  mergeCell,
  minPoolTile,
} from "./grid.js";
import { TileStore } from "./store.js";

export interface TileAccumulator {
  add(sample: Sounding): void;
  flush(): void;
  /** Tiles touched since the last flush. */
  readonly pending: number;
}

export interface AccumulatorOptions {
  baseZoom?: number;
  /** Rebuild each changed tile's ancestors on flush (the default). Set `false`
   * for a bulk load and call {@link rebuildAncestors} once at the end: walking
   * the whole pyramid for every changed tile on every batch repeats the same
   * work whenever a tile is touched in many batches. */
  ancestors?: boolean;
}

export function createTileAccumulator(
  store: TileStore,
  { baseZoom = BASE_ZOOM, ancestors = true }: AccumulatorOptions = {},
): TileAccumulator {
  const dirty = new Map<
    string,
    { z: number; x: number; y: number; cells: TileCells }
  >();

  return {
    add(sample: Sounding) {
      if (
        !Number.isFinite(sample.lon) ||
        !Number.isFinite(sample.lat) ||
        !Number.isFinite(sample.depth) ||
        sample.depth < 0
      ) {
        return;
      }
      const { x, y, cx, cy } = lngLatToCell(sample.lon, sample.lat, baseZoom);
      const key = `${x},${y}`;
      let tile = dirty.get(key);
      if (!tile) {
        tile = { z: baseZoom, x, y, cells: new Map() };
        dirty.set(key, tile);
      }
      mergeCell(tile.cells, cy * TILE_SIZE + cx, encodeDepth(sample.depth));
    },

    flush() {
      if (dirty.size === 0) return;
      const tiles = [...dirty.values()];
      dirty.clear();
      store.transaction(() => {
        for (const tile of tiles) {
          store.merge(tile.z, tile.x, tile.y, tile.cells);
          if (ancestors) {
            store.updateAncestors(tile.z, tile.x, tile.y);
          }
        }
      });
    },

    get pending() {
      return dirty.size;
    },
  };
}

/**
 * Build every level of the pyramid from the base tiles in one bottom-up pass:
 * pool each level into the one below, reading each child once. Used after a
 * bulk load that ran with `ancestors: false`, so the whole pyramid is built
 * once rather than re-walked per changed tile per batch.
 */
export function rebuildAncestors(
  store: TileStore,
  {
    baseZoom = BASE_ZOOM,
    minZoom = MIN_ZOOM,
  }: { baseZoom?: number; minZoom?: number } = {},
): void {
  for (let z = baseZoom; z > minZoom; z--) {
    const parents = new Map<string, { x: number; y: number }>();
    for (const { x, y } of store.listTiles(z)) {
      const px = x >> 1;
      const py = y >> 1;
      parents.set(`${px},${py}`, { x: px, y: py });
    }
    store.transaction(() => {
      for (const { x, y } of parents.values()) {
        store.write(
          z - 1,
          x,
          y,
          minPoolTile([
            store.read(z, x * 2, y * 2),
            store.read(z, x * 2 + 1, y * 2),
            store.read(z, x * 2, y * 2 + 1),
            store.read(z, x * 2 + 1, y * 2 + 1),
          ]),
        );
      }
    });
  }
}

/**
 * Rebuild the ancestors of the given base tiles only, level by level, so a
 * backfill re-pools the part of the pyramid it touched rather than all of it.
 */
export function rebuildAncestorsOf(
  store: TileStore,
  tiles: Iterable<{ x: number; y: number }>,
  {
    baseZoom = BASE_ZOOM,
    minZoom = MIN_ZOOM,
  }: { baseZoom?: number; minZoom?: number } = {},
): void {
  let level = new Map<string, { x: number; y: number }>();
  for (const { x, y } of tiles) level.set(`${x},${y}`, { x, y });
  for (let z = baseZoom; z > minZoom && level.size > 0; z--) {
    const parents = new Map<string, { x: number; y: number }>();
    for (const { x, y } of level.values()) {
      parents.set(`${x >> 1},${y >> 1}`, { x: x >> 1, y: y >> 1 });
    }
    store.transaction(() => {
      for (const { x, y } of parents.values()) {
        store.write(
          z - 1,
          x,
          y,
          minPoolTile([
            store.read(z, x * 2, y * 2),
            store.read(z, x * 2 + 1, y * 2),
            store.read(z, x * 2, y * 2 + 1),
            store.read(z, x * 2 + 1, y * 2 + 1),
          ]),
        );
      }
    });
    level = parents;
  }
}
