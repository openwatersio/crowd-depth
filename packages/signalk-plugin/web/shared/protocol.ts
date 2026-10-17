// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
/** The message contract between the runtime and its render Worker. Kept in one
 * module so both sides import the same shapes without pulling the other in. */

import type { DepthSample } from "./live-depth.js";
import type { LayerSettings } from "./settings.js";

/** One `overlay.request` (see the Plotter Extensions API). */
export interface RenderRequest {
  overlayId: string;
  requestId: string;
  /** EPSG:3857 `[minX, minY, maxX, maxY]`, may run past ±20037508.34 m. */
  extent: [number, number, number, number];
  /** The same box as `[west, south, east, north]` lon/lat. */
  bounds: [number, number, number, number];
  width: number;
  height: number;
  pixelRatio: number;
  /** Metres per image pixel. */
  resolution: number;
  zoom: number;
  /** Radians clockwise; advisory, for keeping labels upright. */
  rotation: number;
  /** Least time (ms) the host accepts between two live (unrequested) frames. */
  liveInterval?: number;
}

export type RenderWorkerIn =
  /** `cellMetres`: the tile cell size the samples were read at. */
  | { type: "samples"; samples: DepthSample[]; cellMetres: number }
  | { type: "settings"; settings: LayerSettings }
  /** The user's preferred depth unit (`"m"` or `"foot"`), for the labels. */
  | { type: "units"; depth: string }
  | { type: "render"; req: RenderRequest }
  | { type: "release" };

export type RenderWorkerOut =
  | { type: "frame"; requestId: string; image: ImageBitmap }
  | { type: "error"; message: string };
