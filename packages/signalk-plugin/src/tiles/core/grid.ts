// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
/**
 * Fixed-grid geometry for the bathymetry tile store.
 *
 * Shared by the plugin and the chart client, so the two build
 * and read identical tiles. The byte codec uses `DataView`/`Uint8Array`, which
 * works both under Node and in the browser, against the `sparse-v1` wire
 * format.
 *
 * A Web-Mercator XYZ quadtree: level `z` splits the world into `2^z` tiles of
 * {@link TILE_SIZE} cells each, so a tile's cell grid is square on the ground.
 * The base level is chosen so a cell is about a metre; coarser levels
 * are the min-pooled parents (see {@link minPoolTile}), so a shoal is never lost
 * when the chart is zoomed out.
 *
 * A tile is stored sparsely — only cells that have a sounding — because a
 * vessel's track is a thin line through a tile and a dense 256x256 array would
 * be almost entirely empty. Each occupied cell is a 5-byte record:
 * `cx:u8, cy:u8, depthCm:u16le, count:u8`.
 */

export const TILE_SIZE = 256;
/** Base level: cell ≈ 0.15 m at the equator. Fine cells cost little, since a
 * track is sparse and soundings a few metres apart each take one cell at any
 * level, and they keep the soundings at full precision: coarser levels can
 * always be pooled from them later, never the reverse. */
export const BASE_ZOOM = 20;

/** Finest level the chart draws: cell ≈ 0.6 m at the equator. A single-beam
 * sounding covers a metre or more of seabed in shallow water, and its position
 * carries sounder lag and heading error on top of the GNSS fix, so drawing
 * finer would show precision the soundings don't have and break a track into
 * dots. */
export const DISPLAY_MAX_ZOOM = 18;
/** Coarsest level built and served (≈ 2.4 km/cell at z4). Low enough that a
 * regional zoom-out is covered by a handful of tiles; the min-pool keeps a
 * shoal visible however far the chart is zoomed out. */
export const MIN_ZOOM = 4;
/** Decoded value for a cell with no sounding. Never stored. */
export const NODATA = 0xffff;
/** Bytes per occupied cell: cx(1) + cy(1) + depth(2) + count(1). */
export const RECORD_BYTES = 5;

const EARTH_RADIUS = 6378137;
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS; // 20037508.342789244
const WORLD_WIDTH = 2 * ORIGIN_SHIFT;

/** One cell's aggregate: shallowest depth in centimetres and how many soundings. */
export type Cell = { depth: number; count: number };
/** A tile's occupied cells, keyed by `cy * TILE_SIZE + cx`. */
export type TileCells = Map<number, Cell>;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** Ground size of one cell, in metres, on the equator. */
export function cellSize(z: number): number {
  return WORLD_WIDTH / (TILE_SIZE * Math.pow(2, z));
}

/** Fractional tile coordinates of a lon/lat at level z (x east, y south). */
function tileFraction(lon: number, lat: number, z: number) {
  const n = Math.pow(2, z);
  const latRad = (clamp(lat, -85.05112878, 85.05112878) * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y, n };
}

/** The level-z tile and the cell within it that contains a lon/lat. */
export function lngLatToCell(lon: number, lat: number, z: number) {
  const { x: fx, y: fy, n } = tileFraction(lon, lat, z);
  const x = clamp(Math.floor(fx), 0, n - 1);
  const y = clamp(Math.floor(fy), 0, n - 1);
  const cx = clamp(Math.floor((fx - x) * TILE_SIZE), 0, TILE_SIZE - 1);
  const cy = clamp(Math.floor((fy - y) * TILE_SIZE), 0, TILE_SIZE - 1);
  return { x, y, cx, cy };
}

/** Quantise a depth in metres to the store's centimetre resolution, rounding
 * toward shoal so a stored depth is never deeper than the sounding. The small
 * allowance keeps float error (12.34 * 100 = 1233.999…) from dropping a
 * centimetre. */
export function encodeDepth(metres: number): number {
  if (!Number.isFinite(metres)) return NODATA;
  return clamp(Math.floor(metres * 100 + 1e-6), 0, NODATA - 1);
}

/** Decode a stored depth in centimetres back to metres. */
export function decodeDepth(cm: number): number {
  return cm === NODATA ? NaN : cm / 100;
}

/** Merge a sounding into a cell, keeping the shallowest and counting samples. */
export function mergeCell(
  cells: TileCells,
  key: number,
  depthCm: number,
  count = 1,
): void {
  const existing = cells.get(key);
  if (!existing) {
    cells.set(key, { depth: depthCm, count: Math.min(255, count) });
    return;
  }
  if (depthCm < existing.depth) existing.depth = depthCm;
  existing.count = Math.min(255, existing.count + count);
}

/** Encode a tile's cells to its sparse on-the-wire representation. */
export function encodeTile(cells: TileCells): Uint8Array {
  const bytes = new Uint8Array(cells.size * RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const [key, { depth, count }] of cells) {
    view.setUint8(offset, key % TILE_SIZE);
    view.setUint8(offset + 1, Math.floor(key / TILE_SIZE));
    view.setUint16(offset + 2, depth, true);
    view.setUint8(offset + 4, count);
    offset += RECORD_BYTES;
  }
  return bytes;
}

/** Decode a sparse tile buffer back to its cells. */
export function decodeTile(bytes: Uint8Array): TileCells {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cells: TileCells = new Map();
  for (let o = 0; o + RECORD_BYTES <= view.byteLength; o += RECORD_BYTES) {
    const cx = view.getUint8(o);
    const cy = view.getUint8(o + 1);
    const depth = view.getUint16(o + 2, true);
    const count = view.getUint8(o + 4);
    cells.set(cy * TILE_SIZE + cx, { depth, count });
  }
  return cells;
}

/**
 * Build a parent tile's cells from its four child tiles (level z+1, ordered
 * `[northwest, northeast, southwest, southeast]` = `[(0,0),(1,0),(0,1),(1,1)]`
 * in child-tile offsets). A parent cell keeps the **minimum** depth of its four
 * children and the summed count, so zooming out never deepens a shoal.
 */
export function minPoolTile(children: (TileCells | undefined)[]): TileCells {
  const parent: TileCells = new Map();
  children.forEach((child, index) => {
    if (!child) return;
    const dx = index & 1;
    const dy = index >> 1;
    for (const [key, { depth, count }] of child) {
      const cx = key % TILE_SIZE;
      const cy = Math.floor(key / TILE_SIZE);
      const pcx = (dx * TILE_SIZE + cx) >> 1;
      const pcy = (dy * TILE_SIZE + cy) >> 1;
      mergeCell(parent, pcy * TILE_SIZE + pcx, depth, count);
    }
  });
  return parent;
}
