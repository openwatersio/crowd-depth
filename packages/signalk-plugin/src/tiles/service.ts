import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { CellStore, OVERVIEW_LEVELS } from "./cells.js";
import type { Changed } from "./writer.js";
import {
  M_PER_DEG_LAT,
  mPerDegLon,
  tileBounds,
  tileFraction,
  tileMetres,
} from "./geometry.js";
import {
  CELL_M,
  MARGIN_M,
  MAX_ZOOM,
  MIN_ZOOM,
  buildTile,
  rasterSize,
} from "./surface.js";

/** The coarsest overview whose blocks are no larger than a tile's pixels. */
export function overviewLevel(z: number, lat: number): number {
  const pm = tileMetres(z, lat) / rasterSize(z, lat);
  return Math.max(0, ...OVERVIEW_LEVELS.filter((l) => CELL_M * 2 ** l <= pm));
}

/** Threads that build tiles. */
const TILE_THREADS = Math.max(1, Math.min(3, availableParallelism() - 1));

/** Encoded tiles kept in memory. A z13 tile of busy water is a few KB. */
const CACHE_TILES = 2000;
/** Below this zoom a tile covers a bay or more, so it's rebuilt from many cells, and
 * the boat's latest pass hardly shows: those tiles refresh on a slow timer. */
const SLOW_BELOW_ZOOM = 10;
export const SLOW_REFRESH_MS = 5 * 60_000;
/** Revisions of changed tiles a client can catch up on before it refetches them all. */
const HISTORY = 500;

export type TileId = [z: number, x: number, y: number];

/** A tile built from the store: the cells under it and its margin, at the overview that
 * fits its pixels, and the unconfirmed shoals in it. */
export function readTile(
  store: CellStore,
  z: number,
  x: number,
  y: number,
): Buffer | undefined {
  const b = tileBounds(z, x, y);
  const lat = Math.max(Math.abs(b.north), Math.abs(b.south));
  const dLat = MARGIN_M / M_PER_DEG_LAT;
  const dLon = MARGIN_M / mPerDegLon(Math.min(lat, 85));
  return buildTile(
    z,
    x,
    y,
    store.cells(
      b.west - dLon,
      b.south - dLat,
      b.east + dLon,
      b.north + dLat,
      overviewLevel(z, (b.north + b.south) / 2),
    ),
    store.shoals(b.west, b.south, b.east, b.north),
  );
}

/** Build tiles on a worker thread reading the database file, so a tile's interpolation
 * doesn't hold up the server: the database is in WAL mode, so the worker reads while
 * the plugin writes. */
function createTileWorker(file: string) {
  let worker: Worker | undefined;
  let next = 0;
  const waiting = new Map<
    number,
    { resolve: (t: Buffer | undefined) => void; reject: (e: Error) => void }
  >();
  const start = () => {
    worker = new Worker(new URL("./tile-worker.js", import.meta.url), {
      workerData: { file },
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
    build(z: number, x: number, y: number): Promise<Buffer | undefined> {
      if (!worker) start();
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker!.postMessage({ id, z, x, y });
      });
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
 * in-memory database, in turn on this one.
 */
export function createTileService(store: CellStore, file?: string) {
  const cache = new Map<string, Buffer | null>();
  /** Bumped when a tile changes, so a build that started before isn't cached. */
  const stamps = new Map<string, number>();
  const building = new Map<string, Promise<Buffer | undefined>>();
  // A few threads, leaving a core for the server: a chart asks for a view's tiles at
  // once, and each takes up to a second or so on a Pi.
  const workers = file
    ? Array.from({ length: TILE_THREADS }, () => createTileWorker(file))
    : [];
  let turn = 0;
  const build = (z: number, x: number, y: number) =>
    workers.length
      ? workers[turn++ % workers.length].build(z, x, y)
      : Promise.resolve(readTile(store, z, x, y));
  // Revisions count from the time the service started, so a client holding one from
  // before a restart is behind every revision this one keeps, and refetches everything.
  let rev = Date.now();
  let oldest = rev + 1;
  const changes: { rev: number; tiles: TileId[] }[] = [];
  const slow = new Map<string, TileId>();

  const publish = (tiles: TileId[]) => {
    for (const [z, x, y] of tiles) {
      const k = `${z}/${x}/${y}`;
      cache.delete(k);
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
        // Map order is insertion order: move the hit to the end, the newest.
        const hit = cache.get(k)!;
        cache.delete(k);
        cache.set(k, hit);
        return hit ?? undefined;
      }
      const pending = building.get(k);
      if (pending) return pending;
      const stamp = stamps.get(k);
      const result = build(z, x, y).finally(() => {
        if (building.get(k) === result) building.delete(k);
      });
      building.set(k, result);
      const tile = await result;
      if (stamps.get(k) === stamp) {
        cache.set(k, tile ?? null);
        if (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value!);
      }
      return tile;
    },

    /** Mark the tiles within the surface's margin of changed cells as changed. */
    changed(positions: Changed) {
      const now = new Map<string, TileId>();
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
              (z < SLOW_BELOW_ZOOM ? slow : now).set(id.join("/"), id);
            }
          }
        }
      }
      if (now.size) publish([...now.values()]);
    },

    /** Drop every tile, as after a backfill or a rebuild. */
    reset() {
      cache.clear();
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
