import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { CellStore, OVERVIEW_LEVELS } from "./cells.js";
import type { Prepared } from "./portray.js";
import type { Changed } from "./writer.js";
import {
  M_PER_DEG_LAT,
  cellCenter,
  mPerDegLon,
  tileFraction,
  tileMetres,
} from "./geometry.js";
import { tileReach, type KeptTiles } from "./kept.js";
import {
  CELL_M,
  MARGIN_M,
  MAX_ZOOM,
  MIN_ZOOM,
  buildTile,
  rasterSize,
  Detail,
  SHARED_ZOOM,
  sharedTile,
} from "./surface.js";

/** The coarsest overview whose blocks are no larger than a tile's pixels. */
export function overviewLevel(z: number, lat: number): number {
  const pm = tileMetres(z, lat) / rasterSize(z, lat);
  return Math.max(0, ...OVERVIEW_LEVELS.filter((l) => CELL_M * 2 ** l <= pm));
}

/** Threads that build tiles. Worked out when a service starts, not when the module
 * loads, which the API's Worker bundle does too. */
const tileThreads = () => Math.max(1, Math.min(3, availableParallelism() - 1));

/** Bytes of encoded tiles kept in memory, the most recently used: a z13 tile of busy
 * water at High detail is about 60 KB, so a few views' worth. Tiles kept on disk are read
 * back in a millisecond or so. */
export const CACHE_BYTES = 16 * 1024 * 1024;
/** What a cached empty tile, and each entry's key, are counted as. */
const ENTRY_BYTES = 100;
/** Below this zoom a tile covers a bay or more, so it's rebuilt from many cells, and
 * the boat's latest pass hardly shows: those tiles refresh on a slow timer. */
const SLOW_BELOW_ZOOM = 10;
export const SLOW_REFRESH_MS = 5 * 60_000;
/** A tile changed within this long isn't kept on disk: underway, the tiles round the
 * boat change with every flush, and keeping each would only wear the SD card. */
export const KEEP_QUIET_MS = 10 * 60_000;
/** Revisions of changed tiles a client can catch up on before it refetches them all. */
const HISTORY = 500;
/** How often tiles changed under way are checked for having settled, to build and keep
 * them on disk. */
const SETTLE_CHECK_MS = 60_000;
/** Tiles built ahead fill the kept bound to this share, leaving the rest for those a
 * plotter asks for: past the bound each would only push out one kept before it. */
const AHEAD_SHARE = 3 / 4;
/** The overview level whose blocks, 16 cells or about 330 m, find the tiles to build. */
const AHEAD_LEVEL = 4;
/** How far the boat moves before the tiles to build are ordered again. */
const REORDER_M = 500;
/** The widest a cell gets: its columns are up to half as wide again as its rows. */
const CELL_W = 1.5 * CELL_M;
/** How far a written overview block's trigger drops kept tiles past a changed cell: the
 * block's cell may be a block away, and the trigger reaches a block past that. */
const OVERVIEW_M = 2 * CELL_W * 2 ** Math.max(...OVERVIEW_LEVELS);
/** Tiles changed under way are built ahead only in the view of a plotter that polled for
 * changes this recently: elsewhere they're built when asked for, or once settled. */
const WATCHED_MS = 30_000;
/** The most tiles a view is counted over: past it, it's not a plotter's view. */
const VIEW_TILES = 64;

export type TileId = [z: number, x: number, y: number];

/** The tiles at zoom `z` over a box, as column and row ranges, or undefined over more
 * than VIEW_TILES tiles: then it's not a plotter's view. Across the antimeridian, `x1`
 * is past the last column, and wraps. */
function viewTiles(
  z: number,
  west: number,
  south: number,
  east: number,
  north: number,
) {
  const a = tileFraction(west, north, z);
  const b = tileFraction(east, south, z);
  const n = 2 ** z;
  const x0 = Math.floor(a.x);
  // Across the antimeridian, west is east of east.
  const x1 = Math.floor(b.x) + (b.x < a.x ? n : 0);
  const [y0, y1] = [Math.floor(a.y), Math.floor(b.y)];
  const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
  if (!(w >= 1 && h >= 1 && w * h <= VIEW_TILES)) return undefined;
  return { z, n, x0, x1, y0, y1 };
}

/** The surfaces tiles past SHARED_ZOOM are cut from, by store, the last few built in
 * this thread; dropped when their cells change. */
const shared = new WeakMap<CellStore, Map<string, Prepared>>();
const SHARED_KEPT = 4;

const sharedFor = (store: CellStore) => {
  let m = shared.get(store);
  if (!m) shared.set(store, (m = new Map()));
  return m;
};

/** Drop the surfaces tiles share, those of the ancestors `keys` (`z/x/y`), or all of
 * them, as when their cells change. */
export function clearShared(store: CellStore, keys?: string[]) {
  const m = sharedFor(store);
  if (keys) for (const k of keys) m.delete(k);
  else m.clear();
}

/** The tiles at zoom `z` within `m` metres of a position; across the antimeridian, the
 * tiles on the other side. */
function tilesWithin(lon: number, lat: number, m: number, z: number) {
  const dLat = m / M_PER_DEG_LAT;
  const dLon = m / mPerDegLon(Math.min(Math.abs(lat), 85));
  const a = tileFraction(lon - dLon, lat + dLat, z);
  const b = tileFraction(lon + dLon, lat - dLat, z);
  const n = 2 ** z;
  const out: TileId[] = [];
  for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) {
    for (
      let y = Math.max(0, Math.floor(a.y));
      y <= Math.min(n - 1, Math.floor(b.y));
      y++
    ) {
      out.push([z, ((x % n) + n) % n, y]);
    }
  }
  return out;
}

/** The ancestors at SHARED_ZOOM whose surfaces a change at `positions` reaches. */
function sharedKeys(positions: Changed): string[] {
  const keys = new Set<string>();
  for (const { lon, lat } of positions) {
    for (const t of tilesWithin(lon, lat, MARGIN_M, SHARED_ZOOM)) {
      keys.add(t.join("/"));
    }
  }
  return [...keys];
}

/** Every tile, at every zoom, within the surface's margin of a cell: those that may draw
 * something. Found from the overview blocks, a block's reach being its cell's plus its
 * own size, so a few tiles past the margin come too. */
export function tilesNear(store: CellStore): TileId[] {
  const reach = CELL_W * 2 ** AHEAD_LEVEL + MARGIN_M;
  const n = 2 ** MAX_ZOOM;
  // Tiles at MAX_ZOOM, as y * n + x; those further out are their ancestors.
  let level = new Set<number>();
  for (const { py, px } of store.blocks(AHEAD_LEVEL)) {
    const { lon, lat } = cellCenter(py, px);
    for (const [, x, y] of tilesWithin(lon, lat, reach, MAX_ZOOM)) {
      level.add(y * n + x);
    }
  }
  const out: TileId[] = [];
  for (let z = MAX_ZOOM, nz = n; z >= MIN_ZOOM; z--, nz /= 2) {
    const up = new Set<number>();
    for (const k of level) {
      const x = k % nz;
      const y = (k - x) / nz;
      out.push([z, x, y]);
      up.add((y >> 1) * (nz / 2) + (x >> 1));
    }
    level = up;
  }
  return out;
}

/** A tile built from the store: the cells under it, or under the ancestor it's cut from,
 * and its margin, at the overview that fits its pixels, and the unconfirmed shoals in it
 * and its margin. */
export function readTile(
  store: CellStore,
  z: number,
  x: number,
  y: number,
  detail: Detail = "high",
  share = true,
): Buffer | undefined {
  const kept = share ? sharedFor(store) : undefined;
  const a = sharedTile(z, x, y);
  // The ancestor's cells to build its surface; once it's built, the tile's own, for its
  // soundings and quality.
  const own = kept?.has(`${a.z}/${a.x}/${a.y}`) ?? false;
  // Room for the surface this tile will keep.
  if (kept && !own && z > SHARED_ZOOM) {
    while (kept.size >= SHARED_KEPT) kept.delete(kept.keys().next().value!);
  }
  // The box a kept tile is dropped by (kept.ts) holds this one.
  const r = own ? tileReach(z, x, y, true) : tileReach(z, x, y);
  const mid = (r.north + r.south) / 2;
  return buildTile(
    z,
    x,
    y,
    store.cells(r.west, r.south, r.east, r.north, overviewLevel(a.z, mid)),
    // Over the margin too, whose shoals cap the depths carried beside them.
    store.shoals(r.west, r.south, r.east, r.north),
    detail,
    kept,
  );
}

/** Build tiles on a worker thread reading the database file, so a tile's interpolation
 * doesn't hold up the server: the database is in WAL mode, so the worker reads while
 * the plugin writes. */
function createTileWorker(file: string, detail: Detail) {
  let worker: Worker | undefined;
  let next = 0;
  const waiting = new Map<
    number,
    { resolve: (t: Buffer | undefined) => void; reject: (e: Error) => void }
  >();
  const start = () => {
    worker = new Worker(new URL("./tile-worker.js", import.meta.url), {
      workerData: { file, detail },
    });
    worker.unref();
    worker.on("message", ({ id, tile, error }) => {
      const w = waiting.get(id);
      waiting.delete(id);
      if (error) w?.reject(new Error(error));
      else w?.resolve(tile ? Buffer.from(tile) : undefined);
    });
    const fail = (err: Error) => {
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
      worker = undefined;
    };
    worker.on("error", (err) => fail(err as Error));
    // An exit with tiles still asked for answers them, rather than leaving them hanging;
    // the next request starts a new thread.
    worker.on("exit", (code) =>
      fail(new Error(`tile worker exited (${code})`)),
    );
  };
  return {
    /** Whether a tile is being built or waits to be. */
    get busy() {
      return waiting.size > 0;
    },
    build(
      z: number,
      x: number,
      y: number,
      share: boolean,
    ): Promise<Buffer | undefined> {
      if (!worker) start();
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker!.postMessage({ id, z, x, y, share });
      });
    },
    clear(keys?: string[]) {
      worker?.postMessage({ clear: keys ?? true });
    },
    close() {
      void worker?.terminate();
      worker = undefined;
      for (const w of waiting.values())
        w.reject(new Error("tile worker closed"));
      waiting.clear();
    },
  };
}

export type TileService = ReturnType<typeof createTileService>;
type TileWorker = ReturnType<typeof createTileWorker>;

/** What building tiles ahead needs. */
export interface Ahead {
  /** Where the boat is, to build the tiles nearest it first. */
  position: () => { lon: number; lat: number } | undefined;
  log?: (message: string) => void;
}

/**
 * Serves the live layer's tiles, built on request from the cells and cached, and keeps a
 * feed of which tiles changed, numbered by revision, for the chart to refetch just those.
 * Given the database `file`, tiles are built on a worker thread; otherwise, as for an
 * in-memory database, in turn on this one. Given `kept`, built tiles are also kept on
 * disk, and read back from there before they're built.
 *
 * Given `ahead` too, every tile that may draw something is built in the background and
 * kept, so a plotter's pan or zoom reads tiles already built: nearest the boat first,
 * zoom 13 and out before 14 and 15, which plotters ask for only closer in, and only on a
 * thread with no tile asked for, so a plotter waits on one such tile at most. Tiles a
 * change drops are built again: those changed under way into memory where a plotter's
 * view shows them, and onto disk once they settle.
 */
export function createTileService(
  store: CellStore,
  file?: string,
  detail: Detail = "high",
  kept?: KeptTiles,
  ahead?: Ahead,
) {
  const cache = new Map<string, Buffer | null>();
  let cached = 0;
  const size = (t: Buffer | null) => ENTRY_BYTES + (t?.length ?? 0);
  const uncache = (k: string) => {
    if (!cache.has(k)) return;
    cached -= size(cache.get(k)!);
    cache.delete(k);
  };
  /** Each tile's bytes when last built or read, for a view's weight while it's rebuilt. */
  const sizes = new Map<string, number>();
  const toCache = (k: string, t: Buffer | null) => {
    sizes.set(k, t?.length ?? 0);
    uncache(k);
    cache.set(k, t);
    cached += size(t);
    // Map order is insertion order: the first is the least recently used.
    while (cached > CACHE_BYTES) uncache(cache.keys().next().value!);
  };
  // The cache on disk is only ever a saving: a tile it fails to read or keep is built.
  const fromDisk = (z: number, x: number, y: number) => {
    try {
      return kept?.get(z, x, y);
    } catch {
      return undefined;
    }
  };
  /** When each tile last changed, for those changed within KEEP_QUIET_MS. */
  const changedAt = new Map<string, number>();
  const quiet = (k: string) =>
    Date.now() - (changedAt.get(k) ?? -Infinity) >= KEEP_QUIET_MS;
  const reserve = (z: number, x: number, y: number) => {
    // Not while a backfill writes: its transactions hold the write lock, which this
    // would wait on with the server's thread, and its writes drop the tile anyway.
    if (!sharing || !quiet(`${z}/${x}/${y}`)) return undefined;
    try {
      return kept?.reserve(z, x, y);
    } catch {
      return undefined;
    }
  };
  /** Bumped when a tile changes, so a build that started before isn't cached. */
  const stamps = new Map<string, number>();
  const building = new Map<string, Promise<Buffer | undefined>>();
  // A few threads, leaving a core for the server: a chart asks for a view's tiles at
  // once, and each takes up to a second or so on a Pi.
  const workers = file
    ? Array.from({ length: tileThreads() }, () =>
        createTileWorker(file, detail),
      )
    : [];
  let turn = 0;
  // Tiles cut from one ancestor's surface go to one worker, which builds it once.
  const worker = (z: number, x: number, y: number) => {
    // An idle thread first, rather than one building a tile ahead.
    if (z < SHARED_ZOOM) {
      return workers.find((w) => !w.busy) ?? workers[turn++ % workers.length];
    }
    const a = sharedTile(z, x, y);
    return workers[(a.x * 31 + a.y) % workers.length];
  };
  let sharing = true;
  const build = (z: number, x: number, y: number, w = worker(z, x, y)) =>
    w
      ? w.build(z, x, y, sharing)
      : Promise.resolve(readTile(store, z, x, y, detail, sharing));

  /** Build a tile, on worker `w` when built ahead, and keep it on disk where it can be;
   * in memory if it was asked for, or can't be kept on disk yet. */
  const load = (k: string, z: number, x: number, y: number, w?: TileWorker) => {
    const stamp = stamps.get(k);
    // Before the build reads the cells, so a write after it drops the reservation.
    const id = reserve(z, x, y);
    const result: Promise<Buffer | undefined> = build(z, x, y, w)
      .then((tile) => {
        sizes.set(k, tile?.length ?? 0);
        let onDisk = false;
        // Not once a backfill has started meanwhile, whose write lock this would wait on.
        if (id !== undefined && sharing) {
          try {
            onDisk = kept!.keep(id, tile);
          } catch {
            // Built again next time.
          }
        }
        // Built ahead, a tile is held in memory only where it isn't kept on disk, as
        // when a write dropped its reservation.
        if (stamps.get(k) === stamp && (!w || !onDisk)) {
          toCache(k, tile ?? null);
        }
        return tile;
      })
      .finally(() => {
        if (building.get(k) === result) building.delete(k);
        pump();
      });
    building.set(k, result);
    return result;
  };

  // Building ahead: the tiles to build, by key, and in the order to build them.
  const aheadOn = ahead && workers.length && kept ? ahead : undefined;
  const queue = new Map<string, TileId>();
  let order: string[] = [];
  /** Keys in `order` before this one are built or dropped. */
  let first = 0;
  let ordered = false;
  let orderedAt: { lon: number; lat: number } | undefined;
  let closed = false;
  /** The tiles in view of plotters polling for changes, by view, and when each was last
   * reported: polls don't say which plotter they're from, so each view lasts
   * WATCHED_MS. */
  const views = new Map<
    string,
    NonNullable<ReturnType<typeof viewTiles>> & { at: number }
  >();
  const inView = (z: number, x: number, y: number) => {
    const at = Date.now();
    for (const v of views.values()) {
      if (
        at - v.at <= WATCHED_MS &&
        z === v.z &&
        y >= v.y0 &&
        y <= v.y1 &&
        (x - v.x0 + v.n) % v.n <= v.x1 - v.x0
      ) {
        return true;
      }
    }
    return false;
  };
  let built = 0;
  let inFlight = 0;
  let since = 0;

  /** Queue tiles: those a change or a settle brings first, ahead of what's left of a
   * scan, without ordering the whole queue again on every flush; `all`, from a scan, in
   * order. */
  const enqueue = (ids: Iterable<TileId>, all = false) => {
    if (!aheadOn) return;
    const fresh: string[] = [];
    for (const id of ids) {
      const k = id.join("/");
      if (!queue.has(k)) fresh.push(k);
      queue.set(k, id);
    }
    if (all) ordered = false;
    else if (fresh.length) {
      order = [...fresh, ...order.slice(first)];
      first = 0;
    }
    pump();
  };

  /** Nearest the boat first, as the distance to a tile's edge; a zoom 14 and 15 tile by
   * its zoom 14 ancestor's, so the tiles cut from one surface go together. */
  const reorder = () => {
    const at = aheadOn!.position();
    const moved =
      at !== undefined &&
      (orderedAt === undefined ||
        Math.hypot(
          (at.lat - orderedAt.lat) * M_PER_DEG_LAT,
          (at.lon - orderedAt.lon) * mPerDegLon(at.lat),
        ) > REORDER_M);
    if (ordered && !moved) return;
    ordered = true;
    if (at) orderedAt = at;
    const rank = ([z, x, y]: TileId) => {
      const a = z > SHARED_ZOOM ? sharedTile(z, x, y) : { z, x, y };
      let d = 0;
      if (orderedAt) {
        const f = tileFraction(orderedAt.lon, orderedAt.lat, a.z);
        const dx = Math.max(0, a.x - f.x, f.x - a.x - 1);
        const dy = Math.max(0, a.y - f.y, f.y - a.y - 1);
        d = Math.hypot(dx, dy) * tileMetres(a.z, orderedAt.lat);
      }
      return [z >= SHARED_ZOOM ? 1 : 0, d, a.y * 2 ** a.z + a.x, z];
    };
    const ranked = [...queue].map(([k, id]) => ({ k, r: rank(id) }));
    ranked.sort((p, q) => {
      for (let i = 0; i < p.r.length; i++) {
        if (p.r[i] !== q.r[i]) return p.r[i] - q.r[i];
      }
      return 0;
    });
    order = ranked.map((e) => e.k);
    first = 0;
  };

  /** The next tile to build ahead on worker `w`, if any. */
  const next = (w: TileWorker): TileId | undefined => {
    reorder();
    while (first < order.length && !queue.has(order[first])) first++;
    let room: boolean | undefined;
    for (let i = first; i < order.length; i++) {
      const k = order[i];
      const id = queue.get(k);
      if (!id) continue;
      const [z, x, y] = id;
      // Tiles cut from one surface are built on the thread that keeps it.
      if (z >= SHARED_ZOOM && worker(z, x, y) !== w) continue;
      queue.delete(k);
      if (building.has(k)) continue;
      // Kept on disk if it's settled, and there's room; in memory if not settled, and in
      // a plotter's view, for the refresh it's about to ask for.
      if (quiet(k)) {
        room ??= !kept!.full(AHEAD_SHARE);
        if (!room) continue;
      } else if (cache.has(k) || !inView(z, x, y)) continue;
      if (kept!.size(z, x, y) !== undefined) continue;
      return id;
    }
    return undefined;
  };

  /** Give each idle thread a tile to build ahead. */
  function pump() {
    if (!aheadOn || closed || !sharing) return;
    for (const w of workers) {
      if (w.busy) continue;
      let id: TileId | undefined;
      try {
        id = next(w);
      } catch {
        // The kept tiles can't be read: built ahead no further until they can, as a
        // tile kept on disk is only ever a saving.
        return;
      }
      if (!id) continue;
      if (!inFlight && !built) since = Date.now();
      inFlight++;
      built++;
      const [z, x, y] = id;
      load(id.join("/"), z, x, y, w)
        .catch(() => {
          // Built again when it's asked for.
        })
        .finally(() => {
          inFlight--;
          if (!inFlight && !queue.size && built) {
            aheadOn.log?.(
              `built ${built} tiles ahead in ${((Date.now() - since) / 1000).toFixed(1)} s`,
            );
            built = 0;
          }
        });
    }
  }

  /** Queue every tile that may draw something and isn't kept. */
  const scan = () => {
    if (!aheadOn) return;
    try {
      const have = kept!.keys();
      enqueue(
        tilesNear(store).filter((id) => !have.has(id.join("/"))),
        true,
      );
    } catch {
      // Nothing built ahead; tiles are built as they're asked for.
    }
  };
  // Revisions count from the time the service started, so a client holding one from
  // before a restart is behind every revision this one keeps, and refetches everything.
  let rev = Date.now();
  let oldest = rev + 1;
  const changes: { rev: number; tiles: TileId[] }[] = [];
  const slow = new Map<string, TileId>();

  const publish = (tiles: TileId[]) => {
    for (const [z, x, y] of tiles) {
      const k = `${z}/${x}/${y}`;
      uncache(k);
      // A build that started before the change would hand its old tile to the refetch.
      building.delete(k);
      stamps.set(k, (stamps.get(k) ?? 0) + 1);
    }
    changes.push({ rev: ++rev, tiles });
    if (changes.length > HISTORY) oldest = changes.shift()!.rev + 1;
    enqueue(tiles);
  };

  /** Tiles quiet for KEEP_QUIET_MS since they changed, built again to be kept on disk. */
  const settle = () => {
    const at = Date.now();
    const settled: TileId[] = [];
    for (const [k, t] of changedAt) {
      if (at - t < KEEP_QUIET_MS) continue;
      changedAt.delete(k);
      settled.push(k.split("/").map(Number) as TileId);
    }
    enqueue(settled);
  };

  const timer = setInterval(() => {
    if (slow.size === 0) return;
    publish([...slow.values()]);
    slow.clear();
  }, SLOW_REFRESH_MS);
  timer.unref?.();
  const settler = setInterval(settle, SETTLE_CHECK_MS);
  settler.unref?.();
  scan();

  return {
    /** A tile's encoded MVT, or undefined where the boat has no soundings. */
    async get(z: number, x: number, y: number): Promise<Buffer | undefined> {
      const k = `${z}/${x}/${y}`;
      if (cache.has(k)) {
        // Moved to the end, the most recently used.
        const hit = cache.get(k)!;
        toCache(k, hit);
        return hit ?? undefined;
      }
      const pending = building.get(k);
      if (pending) return pending;
      // Kept on disk only while nothing under it has been written since.
      const disk = fromDisk(z, x, y);
      if (disk !== undefined) {
        toCache(k, disk);
        return disk ?? undefined;
      }
      return load(k, z, x, y);
    },

    /** Mark the tiles within the surface's margin of changed cells as changed. */
    changed(positions: Changed) {
      const keys = sharedKeys(positions);
      clearShared(store, keys);
      for (const w of workers) w.clear(keys);
      const now = new Map<string, TileId>();
      // Every kept tile the write may have dropped: besides those that changed, zoom 15
      // tiles cut from a changed ancestor's surface, and any within an overview block of
      // a change, as far as the overviews' trigger reaches. Not kept while the boat is
      // about; built ahead into memory where they're gone and in a plotter's view, and
      // kept once settled.
      const touched = new Map<string, TileId>();
      for (const { lon, lat } of positions) {
        for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
          for (const id of tilesWithin(lon, lat, MARGIN_M, z)) {
            (z < SLOW_BELOW_ZOOM ? slow : now).set(id.join("/"), id);
          }
          if (z === MAX_ZOOM) continue;
          for (const id of tilesWithin(lon, lat, MARGIN_M + OVERVIEW_M, z)) {
            touched.set(id.join("/"), id);
            if (z !== SHARED_ZOOM) continue;
            const [, x, y] = id;
            for (const c of [0, 1, 2, 3]) {
              const t: TileId = [z + 1, 2 * x + (c & 1), 2 * y + (c >> 1)];
              touched.set(t.join("/"), t);
            }
          }
        }
      }
      const at = Date.now();
      for (const k of touched.keys()) changedAt.set(k, at);
      settle();
      if (now.size) publish([...now.values()]);
      enqueue(touched.values());
    },

    /** Share no surfaces between tiles while `on` is false, as while a backfill writes
     * cells on a connection of its own and tells nothing until it ends: each tile is
     * then built from the cells as they stand. */
    share(on: boolean) {
      sharing = on;
      clearShared(store);
      for (const w of workers) w.clear();
      pump();
    },

    /** Drop every tile, as after a backfill or a rebuild. */
    reset() {
      clearShared(store);
      for (const w of workers) w.clear();
      cache.clear();
      cached = 0;
      for (const k of building.keys()) stamps.set(k, (stamps.get(k) ?? 0) + 1);
      building.clear();
      slow.clear();
      sizes.clear();
      rev++;
      oldest = rev + 1;
      changes.length = 0;
      scan();
    },

    /** A plotter polled for changes, showing `view` (zoom and box) where it said: tiles
     * changed under way in any view reported within WATCHED_MS are built ahead. */
    watched(
      view?: readonly [z: number, w: number, s: number, e: number, n: number],
    ) {
      const tiles = view && viewTiles(...view);
      if (!tiles) return;
      const at = Date.now();
      for (const [k, v] of views) if (at - v.at > WATCHED_MS) views.delete(k);
      const k = `${tiles.z}/${tiles.x0}/${tiles.y0}/${tiles.x1}/${tiles.y1}`;
      views.delete(k);
      views.set(k, { ...tiles, at });
    },

    /** Bytes of the tiles at zoom `z` over a box that are built, in memory or kept, or
     * as last built while they're rebuilt: what a plotter showing it holds. Undefined
     * over more than VIEW_TILES tiles. */
    held(
      z: number,
      west: number,
      south: number,
      east: number,
      north: number,
    ): number | undefined {
      const v = viewTiles(z, west, south, east, north);
      if (!v) return undefined;
      const { n, x0, x1, y0, y1 } = v;
      let bytes = 0;
      for (let i = x0; i <= x1; i++) {
        for (let y = y0; y <= y1; y++) {
          const x = i % n;
          const k = `${z}/${x}/${y}`;
          let size: number | undefined;
          if (cache.has(k)) size = cache.get(k)?.length ?? 0;
          else {
            try {
              size = kept?.size(z, x, y);
            } catch {
              // Counted as when last built.
            }
          }
          // Being rebuilt, as the changed tiles a refresh is about to ask for are.
          bytes += size ?? sizes.get(k) ?? 0;
        }
      }
      return bytes;
    },

    /** The tiles changed after revision `since`, or `all` when the feed no longer goes
     * back that far. */
    since(since: number): { rev: number; all?: true; tiles: TileId[] } {
      if (since > rev || since < oldest - 1)
        return { rev, all: true, tiles: [] };
      const tiles = new Map<string, TileId>();
      for (const c of changes) {
        if (c.rev > since) for (const t of c.tiles) tiles.set(t.join("/"), t);
      }
      return { rev, tiles: [...tiles.values()] };
    },

    close() {
      closed = true;
      clearInterval(timer);
      clearInterval(settler);
      for (const w of workers) w.close();
    },
  };
}
