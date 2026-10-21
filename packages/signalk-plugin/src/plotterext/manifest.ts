import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The providing plugin's id; also the plotterExtensions resource key. */
export const PLUGIN_ID = "crowd-depth";
/** Top-level, non-admin route the extension's pages and data are served from. */
export const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;
/** The data overlay's id, which the runtime names in `overlay.*` calls. */
export const OVERLAY_ID = "depth";

/** The plotterExtensions manifest (see docs/api/plotter-extensions-api.md). */
export interface PlotterExtManifest {
  name: string;
  description: string;
  version: string;
  apiVersion: string;
  requires: string[];
  optional: string[];
  buttons: unknown[];
  panels: unknown[];
  background: unknown[];
  overlays: unknown[];
}

/** The plugin's own version, read from its package.json. */
function pluginVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Build the extension manifest offered to a host chartplotter.
 *
 * One data overlay, which the host draws from the plugin's style and vector tiles,
 * placed above the charts and below the vessel and resources. A headless background
 * runtime keeps it current: it refetches the tiles the boat's new passes changed and
 * draws the soundings not yet in a cell. Without the runtime the layer still draws, as
 * of when it was shown. */
export function buildManifest(version = pluginVersion()): PlotterExtManifest {
  return {
    name: "Crowd Depth",
    description:
      "Draw the depths this boat records on the chart, with depth areas, contours and soundings.",
    version,
    apiVersion: "1",
    requires: ["overlays.data"],
    optional: ["background.iframe", "units"],
    buttons: [],
    panels: [],
    background: [
      {
        id: "live",
        type: "iframe",
        url: `${ASSET_BASE}/runtime.html`,
      },
    ],
    overlays: [
      {
        id: OVERLAY_ID,
        title: "My soundings",
        type: "data",
        band: "aboveCharts",
        visible: true,
        opacity: 1,
        minZoom: 4,
        style: `${ASSET_BASE}/style.json`,
      },
    ],
  };
}
