// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
/** Helpers for reading the bathymetry tiles.
 *
 * Glue around the grid: pick the tile level for a target ground resolution,
 * work out which tiles cover a viewport, and turn a decoded tile's cells back
 * into lon/lat depth soundings. Pure functions (no HTTP, no framework) so they
 * can be unit tested directly.
 */

import { Sounding } from "./types.js";
import { TransducerOffset } from "./correction.js";
import {
  BASE_ZOOM,
  MIN_ZOOM,
  TILE_SIZE,
  TileCells,
  cellSize,
  decodeDepth,
  decodeTile,
} from "./grid.js";

/** Grid spec served by `/plotterext/crowd-depth/bathymetry/meta`. */
export interface TileMeta {
  format: string;
  baseZoom: number;
  minZoom: number;
  tileSize: number;
  recordBytes: number;
  depthPath?: string;
  /** Offset from the position the server reports to the depth transducer, when
   * the plugin corrects for it; absent or null otherwise. A client applies the
   * same shift to its own soundings so they match the served tiles. */
  transducer?: TransducerOffset | null;
  /** Added to each live depth, as the plugin adds it to the depths it
   * records, so the client's soundings match the served tiles. */
  depthOffset?: number;
}

const RAD = Math.PI / 180;

/** The finest tile level whose cells are no coarser than `cellMetres`, clamped
 * to the served range. Finer than needed wastes requests; coarser loses detail
 * the field could have shown. */
export function zoomForCellSize(
  cellMetres: number,
  minZoom = MIN_ZOOM,
  baseZoom = BASE_ZOOM,
): number {
  if (!(cellMetres > 0)) return baseZoom;
  // Round up, so the chosen level's cells are no coarser than requested.
  const ideal = Math.ceil(
    Math.log2((2 * Math.PI * 6378137) / (TILE_SIZE * cellMetres)),
  );
  return Math.max(minZoom, Math.min(baseZoom, ideal));
}

/** Tile x for a longitude at level z; may fall outside `[0, 2^z)` for a view
 * panned a world away, and is wrapped by the caller. */
function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

/** Tile y for a latitude at level z (south = larger y). */
function latToTileY(lat: number, z: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = clamped * RAD;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    Math.pow(2, z)
  );
}

/** The tiles (wrapped x) covering a `[west, south, east, north]` box at level
 * z. `west > east` is read the short way round the antimeridian. */
export function tileRangeForBbox(
  bbox: readonly number[],
  z: number,
): { xs: number[]; ys: number[] } {
  const n = Math.pow(2, z);
  if (bbox.length !== 4) {
    return { xs: [], ys: [] };
  }
  const [west, south, east, north] = bbox;

  const xStart = Math.floor(lonToTileX(west, z));
  let xEnd = Math.floor(lonToTileX(east, z));
  if (xEnd < xStart) {
    xEnd += n; // wrapped past the antimeridian
  }
  const xCount = Math.min(n, xEnd - xStart + 1);
  const xs: number[] = [];
  for (let i = 0; i < xCount; i++) {
    xs.push((((xStart + i) % n) + n) % n);
  }

  const yStart = Math.max(0, Math.floor(latToTileY(north, z)));
  const yEnd = Math.min(n - 1, Math.floor(latToTileY(south, z)));
  const ys: number[] = [];
  for (let y = yStart; y <= yEnd; y++) {
    ys.push(y);
  }

  return { xs, ys };
}

/** Lon/lat of the centre of a cell within a tile. */
export function tileCellCentre(
  z: number,
  x: number,
  y: number,
  key: number,
): [number, number] {
  const n = Math.pow(2, z);
  const cx = key % TILE_SIZE;
  const cy = Math.floor(key / TILE_SIZE);
  const fx = (x + (cx + 0.5) / TILE_SIZE) / n;
  const fy = (y + (cy + 0.5) / TILE_SIZE) / n;
  const lon = fx * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * fy))) / RAD;
  return [lon, lat];
}

/** Turn a tile's cells into lon/lat depth samples. */
export function cellsToSamples(
  z: number,
  x: number,
  y: number,
  cells: TileCells,
): Sounding[] {
  const samples: Sounding[] = [];
  for (const [key, cell] of cells) {
    const depth = decodeDepth(cell.depth);
    if (!Number.isFinite(depth)) continue;
    const [lon, lat] = tileCellCentre(z, x, y, key);
    samples.push({ lon, lat, depth });
  }
  return samples;
}

/** Decode a served tile blob into lon/lat depth samples. */
export function decodeTileSamples(
  z: number,
  x: number,
  y: number,
  bytes: Uint8Array,
): Sounding[] {
  return cellsToSamples(z, x, y, decodeTile(bytes));
}

export { cellSize };
