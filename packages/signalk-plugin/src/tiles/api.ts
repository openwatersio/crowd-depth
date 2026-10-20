import type { Request, Response } from "express";
import type { ServerAPI } from "@signalk/server-api";
import { ASSET_BASE } from "../plotterext/manifest.js";
import type { Sounding } from "../qc.js";
import { MAX_ZOOM, MIN_ZOOM, depthLabels } from "./surface.js";
import type { TileService } from "./service.js";
import { buildStyle } from "./style.js";

/** The style, tiles and change feed, under the extension's top-level route. */
export const STYLE_PATH = `${ASSET_BASE}/style.json`;
export const TILES_PATH = `${ASSET_BASE}/tiles`;
export const LIVE_PATH = `${ASSET_BASE}/live`;

/** Provisional soundings sent per poll, the newest: about half an hour at 1 Hz. */
const MAX_PROVISIONAL = 2000;

/** What the routes read; replaced on each start. */
export interface Layer {
  tiles: TileService;
  provisional: () => Sounding[];
  safetyDepth: number;
}

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
 * Serve the live layer to the plotter extension and any other chart client, at a
 * top-level, non-admin path (`/plotterext/<id>/…`) so a read-only user's chart can reach
 * it: the provider guide warns that `/plugins/*` is admin-gated.
 *
 * - `style.json`: the MapLibre style the data overlay draws.
 * - `tiles/{z}/{x}/{y}.pbf`: S-57 vector tiles of the boat's cells.
 * - `live?since=<rev>`: the tiles changed since a revision, and the provisional
 *   soundings as GeoJSON, which the extension's runtime polls.
 *
 * `getLayer` is read per request because the routes outlive a plugin restart.
 *
 * Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
 */
export function registerLayerRoutes(
  app: ServerAPI,
  getLayer: () => Layer | undefined,
): void {
  const a = app as RouteApp;
  if (typeof a.get !== "function") return;

  const guard =
    (handler: (req: Request, res: Response, layer: Layer) => unknown) =>
    (req: Request, res: Response) => {
      if (!allowed(a, req)) {
        res.status(401).json({ error: "login required" });
        return;
      }
      const layer = getLayer();
      if (!layer) {
        res.status(503).json({ error: "chart layer not running" });
        return;
      }
      return handler(req, res, layer);
    };

  a.get(
    STYLE_PATH,
    guard((_req, res, layer) => {
      res.set("Cache-Control", "no-cache").json(
        buildStyle({
          tiles: `${TILES_PATH}/{z}/{x}/{y}.pbf`,
          safetyDepth: layer.safetyDepth,
        }),
      );
    }),
  );

  a.get(
    `${TILES_PATH}/:z/:x/:y.pbf`,
    guard((req, res, layer) => {
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      const n = 2 ** z;
      if (
        ![z, x, y].every(Number.isInteger) ||
        z < MIN_ZOOM ||
        z > MAX_ZOOM ||
        x < 0 ||
        x >= n ||
        y < 0 ||
        y >= n
      ) {
        res.status(400).json({ error: "invalid tile coordinates" });
        return;
      }
      return layer.tiles.get(z, x, y).then(
        (tile) => {
          if (!tile) {
            res.status(204).end();
            return;
          }
          res
            .set("Content-Type", "application/vnd.mapbox-vector-tile")
            .set("Cache-Control", "no-cache")
            .send(tile);
        },
        () => {
          res.status(500).json({ error: "tile failed" });
        },
      );
    }),
  );

  a.get(
    LIVE_PATH,
    guard((req, res, layer) => {
      const since = Number(req.query.since ?? -1);
      res.set("Cache-Control", "no-store").json({
        ...layer.tiles.since(Number.isInteger(since) ? since : -1),
        provisional: {
          type: "FeatureCollection",
          features: layer
            .provisional()
            .slice(-MAX_PROVISIONAL)
            // A sounding's id is its time, so the runtime can tell which have left.
            .map((s) => ({
              type: "Feature",
              id: s.time,
              geometry: { type: "Point", coordinates: [s.lon, s.lat] },
              properties: depthLabels(s.depth),
            })),
        },
      });
    }),
  );
}
