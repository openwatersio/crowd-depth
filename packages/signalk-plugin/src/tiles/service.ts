import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { CellStore, OVERVIEW_LEVELS } from "./cells.js";
import type { Prepared } from "./portray.js";
import type { Changed } from "./writer.js";
import {
  M_PER_DEG_LAT,
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

export type TileId = [z: number, x: number, y: number];

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

/** The ancestors at SHARED_ZOOM whose surfaces a change at `positions` reaches. */
function sharedKeys(positions: Changed): string[] {
  const keys = new Set<string>();
  for (const { lon, lat } of positions) {
    const dLat = MARGIN_M / M_PER_DEG_LAT;
    const dLon = MARGIN_M / mPerDegLon(Math.min(Math.abs(lat), 85));
    const a = tileFraction(lon - dLon, lat + dLat, SHARED_ZOOM);
    const b = tileFraction(lon + dLon, lat - dLat, SHARED_ZOOM);
    const n = 2 ** SHARED_ZOOM;
    for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) {
      for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) {
        keys.add(`${SHARED_ZOOM}/${((x % n) + n) % n}/${y}`);
      }
    }
  }
  return [...keys];
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

/**
 * Serves the live layer's tiles, built on request from the cells and cached, and keeps a
 * feed of which tiles changed, numbered by revision, for the chart to refetch just those.
 * Given the database `file`, tiles are built on a worker thread; otherwise, as for an
 * in-memory database, in turn on this one. Given `kept`, built tiles are also kept on
 * disk, and read back from there before they're built.
 */
export function createTileService(
  store: CellStore,
  file?: string,
  detail: Detail = "high",
  kept?: KeptTiles,
) {
  const cache = new Map<string, Buffer | null>();
  let cached = 0;
  const size = (t: Buffer | null) => ENTRY_BYTES + (t?.length ?? 0);
  const uncache = (k: string) => {
    if (!cache.has(k)) return;
    cached -= size(cache.get(k)!);
    cache.delete(k);
  };
  const toCache = (k: string, t: Buffer | null) => {
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
    if (z < SHARED_ZOOM) return workers[turn++ % workers.length];
    const a = sharedTile(z, x, y);
    return workers[(a.x * 31 + a.y) % workers.length];
  };
  let sharing = true;
  const build = (z: number, x: number, y: number) =>
    workers.length
      ? worker(z, x, y).build(z, x, y, sharing)
      : Promise.resolve(readTile(store, z, x, y, detail, sharing));
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
  };

  const timer = setInterval(() => {
    if (slow.size === 0) return;
    publish([...slow.values()]);
    slow.clear();
  }, SLOW_REFRESH_MS);
  timer.unref?.();

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
      const stamp = stamps.get(k);
      // Before the build reads the cells, so a write after it drops the reservation.
      const id = reserve(z, x, y);
      const result = build(z, x, y).finally(() => {
        if (building.get(k) === result) building.delete(k);
      });
      building.set(k, result);
      const tile = await result;
      // Not once a backfill has started meanwhile, whose write lock this would wait on.
      if (id !== undefined && sharing) {
        try {
          kept!.keep(id, tile);
        } catch {
          // Built again next time.
        }
      }
      if (stamps.get(k) === stamp) toCache(k, tile ?? null);
      return tile;
    },

    /** Mark the tiles within the surface's margin of changed cells as changed. */
    changed(positions: Changed) {
      const keys = sharedKeys(positions);
      clearShared(store, keys);
      for (const w of workers) w.clear(keys);
      const now = new Map<string, TileId>();
      const at = Date.now();
      for (const [k, t] of changedAt) {
        if (at - t >= KEEP_QUIET_MS) changedAt.delete(k);
      }
      for (const { lon, lat } of positions) {
        const dLat = MARGIN_M / M_PER_DEG_LAT;
        const dLon = MARGIN_M / mPerDegLon(Math.min(Math.abs(lat), 85));
        for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
          const a = tileFraction(lon - dLon, lat + dLat, z);
          const b = tileFraction(lon + dLon, lat - dLat, z);
          const n = 2 ** z;
          for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) {
            for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) {
              // Across the antimeridian, the tile on the other side.
              const id: TileId = [z, ((x % n) + n) % n, y];
              const k = id.join("/");
              (z < SLOW_BELOW_ZOOM ? slow : now).set(k, id);
              changedAt.set(k, at);
            }
          }
        }
      }
      if (now.size) publish([...now.values()]);
    },

    /** Share no surfaces between tiles while `on` is false, as while a backfill writes
     * cells on a connection of its own and tells nothing until it ends: each tile is
     * then built from the cells as they stand. */
    share(on: boolean) {
      sharing = on;
      clearShared(store);
      for (const w of workers) w.clear();
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
      rev++;
      oldest = rev + 1;
      changes.length = 0;
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
      clearInterval(timer);
      for (const w of workers) w.close();
    },
  };
}
