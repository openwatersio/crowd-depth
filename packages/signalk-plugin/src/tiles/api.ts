import type { Request, Response } from "express";
import type { ServerAPI } from "@signalk/server-api";
import {
  BASE_ZOOM,
  MIN_ZOOM,
  RECORD_BYTES,
  TILE_SIZE,
  TileStore,
  encodeTile,
} from "./core/index.js";
import { ASSET_BASE } from "../plotterext/manifest.js";

/** Wire format of a `/bathymetry/tiles` response. */
export const BATHYMETRY_FORMAT = "sparse-v1";

/** Top-level, non-admin route the store is served from. */
export const BATHYMETRY_BASE = `${ASSET_BASE}/bathymetry`;

/** Extra fields a client needs to mirror the store (depth path, offsets, …). */
export type BathymetryMeta = Record<string, unknown>;

/** The server API also carries Express's route methods, which the typed
 * interface does not declare. */
interface RouteApp extends ServerAPI {
  get?: (path: string, handler: (req: Request, res: Response) => void) => void;
  securityStrategy?: { isDummy?: () => boolean; allowReadOnly?: () => boolean };
}

/**
 * The server lets anonymous requests through its root path without the
 * read-only principal it gives them on the Signal K API, so these routes check
 * access themselves: with security on, a request needs a login, or the server
 * must allow read-only access. The tiles are the boat's recorded positions, so
 * they get the same protection as its position.
 */
function allowed(app: RouteApp, req: Request): boolean {
  const security = app.securityStrategy;
  if (!security || security.isDummy?.() !== false) return true;
  if ((req as Request & { skPrincipal?: unknown }).skPrincipal) return true;
  return security.allowReadOnly?.() === true;
}

/**
 * Serve the gridded store to the extension runtime, and any other chart
 * client.
 *
 * Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
 *
 * Mounted at a top-level, non-admin path
 * (`/plotterext/<id>/bathymetry/…`) so an extension iframe loaded for a
 * read-only user can reach it: the provider guide warns that the `/plugins/*`
 * path is admin-gated. A client seeds its view from these tiles, then keeps its
 * own copy current from the live `navigation.position` + `environment.depth.*`
 * stream the plugin consumes.
 *
 * `getStore`/`getMeta` are read per request because the routes are registered
 * before the plugin's `start()` has built the store.
 */
export function registerBathymetryRoutes(
  app: ServerAPI,
  getStore: () => TileStore | undefined,
  getMeta: () => BathymetryMeta = () => ({}),
): void {
  const a = app as RouteApp;
  if (typeof a.get !== "function") {
    return;
  }

  a.get(`${BATHYMETRY_BASE}/meta`, (req: Request, res: Response) => {
    if (!allowed(a, req)) {
      res.status(401).json({ error: "login required" });
      return;
    }
    res.json({
      format: BATHYMETRY_FORMAT,
      baseZoom: BASE_ZOOM,
      minZoom: MIN_ZOOM,
      tileSize: TILE_SIZE,
      recordBytes: RECORD_BYTES,
      ...getMeta(),
    });
  });

  a.get(`${BATHYMETRY_BASE}/tiles/:z/:x/:y`, (req: Request, res: Response) => {
    if (!allowed(a, req)) {
      res.status(401).json({ error: "login required" });
      return;
    }
    const store = getStore();
    if (!store) {
      res.status(503).json({ error: "bathymetry store not ready" });
      return;
    }
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    const n = Math.pow(2, z);
    if (
      !Number.isInteger(z) ||
      z < MIN_ZOOM ||
      z > BASE_ZOOM ||
      !Number.isInteger(x) ||
      x < 0 ||
      x >= n ||
      !Number.isInteger(y) ||
      y < 0 ||
      y >= n
    ) {
      res.status(400).json({ error: "invalid tile coordinates" });
      return;
    }
    const cells = store.read(z, x, y);
    if (!cells || cells.size === 0) {
      res.status(404).end();
      return;
    }
    // Send a Buffer, not the Uint8Array `encodeTile` returns: express's
    // `res.send` JSON-encodes anything that isn't a Buffer or string (it
    // becomes `{"0":…,"1":…}`), so the client would decode the JSON text as
    // sparse records. `Buffer` is a Uint8Array subclass, so it sends the
    // bytes verbatim.
    res
      .set("Content-Type", "application/octet-stream")
      .set("Cache-Control", "no-cache")
      .send(Buffer.from(encodeTile(cells)));
  });
}
