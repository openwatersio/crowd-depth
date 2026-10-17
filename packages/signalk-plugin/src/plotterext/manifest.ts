import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The providing plugin's id; also the plotterExtensions resource key. */
export const PLUGIN_ID = "crowd-depth";
/** Top-level, non-admin route the extension's pages and data are served from. */
export const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;

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
 * Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
 *
 * One `image` overlay, drawn by a headless background runtime, placed above
 * the charts and below the vessel/resources. A `mapToolbar` button opens the
 * settings panel, which shares state with the runtime over the bus. */
export function buildManifest(version = pluginVersion()): PlotterExtManifest {
  return {
    name: "Crowd Depth",
    description:
      "Draw the depths this boat records as a live depth map on the chart, shaded with depth contours.",
    version,
    apiVersion: "1",
    requires: ["background.iframe", "overlays.image", "signalk.stream"],
    optional: ["buttons", "panels.iframe", "units", "map", "nightMode"],
    buttons: [
      {
        id: "open-my-soundings-settings",
        title: "My soundings",
        slot: "mapToolbar",
        icon: "water",
        action: { type: "togglePanel", panel: "my-soundings-settings" },
      },
    ],
    panels: [
      {
        id: "my-soundings-settings",
        title: "My soundings",
        type: "iframe",
        url: `${ASSET_BASE}/config.html`,
        lifecycle: "keepAlive",
      },
    ],
    background: [
      {
        id: "renderer",
        type: "iframe",
        url: `${ASSET_BASE}/renderer.html`,
      },
    ],
    overlays: [
      {
        id: "depth",
        title: "My soundings",
        type: "image",
        runtime: "renderer",
        band: "aboveCharts",
        visible: true,
        opacity: 0.85,
        minZoom: 4,
        // The Chart list's "Layer settings" button opens this panel, so the
        // layer's settings sit with the layer, not only behind the toolbar
        // button.
        configPanel: "my-soundings-settings",
        // Isobaths and labels want the pixels; the host still clamps to its own
        // memory budget.
        preferredPixelRatio: 2,
      },
    ],
  };
}
