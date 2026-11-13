import type { Request, Response } from "express";
import type { ServerAPI } from "@signalk/server-api";
import { ASSET_BASE } from "../plotterext/manifest.js";
import { charted, type Sounding } from "./writer.js";
import { MAX_ZOOM, MIN_ZOOM, depthLabels, type Detail } from "./surface.js";
import type { TileService } from "./service.js";
import type { GeoFeature, Preview } from "./preview.js";
import { buildStyle, type OwnStyle } from "./style.js";

/** The style, tiles and change feed, under the extension's top-level route. */
export const STYLE_PATH = `${ASSET_BASE}/style.json`;
export const TILES_PATH = `${ASSET_BASE}/tiles`;
export const LIVE_PATH = `${ASSET_BASE}/live`;

/** Provisional soundings sent per poll: the newest in full, and older ones, held while a
 * backfill runs, thinned to as many again, so the whole track stays on the chart. */
const NEWEST_PROVISIONAL = 1000;

/** How long a poll waits for the preview being worked out, before it sends the last. */
const PREVIEW_WAIT_MS = 1000;

/** Refreshes are batched to one per this long, at least and at most. */
const REFRESH_MIN_MS = 5_000;
const REFRESH_MAX_MS = 30_000;
/** Freeboard redraws the whole layer on any refresh, which freezes a plotter about 0.75
 * ms per KB of tiles in view at a 6× CPU throttle: batched so it's 2% of the time. */
const REFRESH_MS_PER_KB = 37.5;

/** How long to batch refreshes for a view holding `bytes` of tiles. */
export function refreshMs(bytes: number): number {
  return Math.round(
    Math.min(
      REFRESH_MAX_MS,
      Math.max(REFRESH_MIN_MS, (bytes / 1024) * REFRESH_MS_PER_KB),
    ),
  );
}

/** A plotter's view from `zoom,west,south,east,north`: the tiles' zoom, a zoom below the
 * map's as plotters draw 512-pixel tiles, and its box. */
export function parseView(view: unknown) {
  if (typeof view !== "string") return undefined;
  const fields = view.split(",");
  if (fields.some((f) => f.trim() === "")) return undefined;
  const [zoom, west, south, east, north] = fields.map(Number);
  const lon = (l: number) => l >= -180 && l <= 180;
  const lat = (l: number) => l >= -85.06 && l <= 85.06;
  if (
    !(zoom >= 0 && zoom <= 30) ||
    !lon(west) ||
    !lon(east) ||
    !lat(south) ||
    !lat(north) ||
    south > north
  ) {
    return undefined;
  }
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.floor(zoom) - 1));
  return [z, west, south, east, north] as const;
}

/** The provisional soundings as points, each named for its time, so the runtime can
 * tell which have left. */
export function provisionalFeatures(soundings: Sounding[]) {
  return soundings.map((s) => ({
    type: "Feature",
    id: s.time,
    geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    properties: depthLabels(charted(s)),
  }));
}

/** Keep the newest soundings of `n`, in time order, and an even share of the rest. */
export function thin(n: number) {
  const older = n - NEWEST_PROVISIONAL;
  const step = Math.max(1, Math.ceil(older / NEWEST_PROVISIONAL));
  return (_: unknown, i: number) => i >= older || i % step === 0;
}

/** What the routes read; replaced on each start. */
export interface Layer {
  tiles: TileService;
  provisional: () => Sounding[];
  stored: () => number[];
  safetyDepth: number;
  own: OwnStyle;
  detail?: Detail;
  preview?: Preview;
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
 * - `live?since=<rev>&view=<zoom,west,south,east,north>&preview=<rev>&unit=<m|ft>`: the
 *   tiles changed since a revision, how long to batch their refreshes for the plotter's
 *   view, the provisional soundings, and the preview, where it's not
 *   the revision the runtime holds, with contours in its unit, all as GeoJSON, which the
 *   extension's runtime polls.
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
      // An async handler's failure, as a sync one's would through Express, is a 500.
      const failed = (err: unknown) => {
        a.error?.(`Chart layer: ${req.path} failed: ${err}`);
        if (!res.headersSent) res.status(500).json({ error: "failed" });
      };
      try {
        const done = handler(req, res, layer);
        return done instanceof Promise ? done.catch(failed) : done;
      } catch (err) {
        failed(err);
      }
    };

  a.get(
    STYLE_PATH,
    guard((_req, res, layer) => {
      res.set("Cache-Control", "no-cache").json(
        buildStyle({
          tiles: `${TILES_PATH}/{z}/{x}/{y}.pbf`,
          safetyDepth: layer.safetyDepth,
          own: layer.own,
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
    guard(async (req, res, layer) => {
      const view = parseView(req.query.view);
      // Only to a runtime that draws it, which says which it holds.
      const held = Number(req.query.preview);
      let preview: { rev: number; features: GeoFeature[] } | undefined;
      if (layer.preview && req.query.preview !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        preview = await Promise.race([
          layer.preview.get(view?.slice(1) as [number, number, number, number]),
          new Promise<undefined>((r) => {
            timer = setTimeout(() => r(undefined), PREVIEW_WAIT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        preview ??= layer.preview.latest();
        if (preview.rev === held) preview = undefined;
        // Contours in the plotter's unit only, where it says which.
        const unit = req.query.unit;
        if (preview && (unit === "m" || unit === "ft")) {
          preview = {
            rev: preview.rev,
            features: preview.features.filter(
              (f) =>
                f.properties.unit === undefined || f.properties.unit === unit,
            ),
          };
        }
      }
      const since = Number(req.query.since ?? -1);
      const provisional = layer.provisional();
      layer.tiles.watched(view);
      const bytes = view && layer.tiles.held(...view);
      res.set("Cache-Control", "no-store").json({
        ...layer.tiles.since(Number.isInteger(since) ? since : -1),
        ...(bytes !== undefined ? { refreshMs: refreshMs(bytes) } : {}),
        // The surface round the boat as it stands, when it's changed.
        ...(preview && {
          preview: {
            rev: preview.rev,
            type: "FeatureCollection",
            features: preview.features,
          },
        }),
        // Ids of soundings just written to cells, which the runtime keeps drawing until
        // their tiles are refreshed; any other that leaves `provisional` is gone.
        stored: layer.stored(),
        provisional: {
          type: "FeatureCollection",
          features: provisionalFeatures(
            provisional
              .sort((a, b) => a.time - b.time)
              .filter(thin(provisional.length)),
          ),
        },
      });
    }),
  );
}
