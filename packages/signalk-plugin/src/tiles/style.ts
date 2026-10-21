// The live layer's MapLibre style: S-57 DEPARE, DEPCNT, SOUNDG and M_QUAL. Its depth
// areas are in Seascape's day palette (openwatersio/seascape style/flavor.ts), so depths
// read as the chart's do, but drawn over a chart in that palette, such as Seamap, they'd
// vanish into it: its soundings, contours and the water the boat sounded itself are
// drawn in a colour of their own. The depth unit is a `global-state` variable the
// runtime sets, and the safety depth one whose default comes from the plugin's settings.
import { MAX_ZOOM, MIN_ZOOM } from "./surface.js";

/** Seascape's day flavor. */
const DAY = {
  // Deepest band first.
  bandColors: [
    "#e9f7ff",
    "#c9e9fd",
    "#a5d9fb",
    "#7fc7f8",
    "#5db5f0",
    "#3fa2e4",
  ],
  bandEdges: [50, 20, 10, 5, 2],
  hazard: "#1f86cb",
  drying: "#58af9c",
  labelHalo: "rgba(255,255,255,0.8)",
  provisional: "#f58231",
  // The boat's own data, in a colour no chart in this palette uses for depths.
  own: "#7b2cbf",
  ownEmphasis: "#3c096c",
  // Tint over the water the boat sounded, and fainter over what's interpolated.
  ownMeasured: 0.14,
  ownInterpolated: 0.07,
};

/** Small float error in stored band edges stays inside a band. */
const EPS = 0.01;

export function buildStyle({
  tiles,
  safetyDepth,
}: {
  tiles: string;
  safetyDepth: number;
}) {
  const band: unknown[] = ["step", ["get", "DRVAL1"], DAY.bandColors[5]];
  [...DAY.bandEdges].reverse().forEach((edge, i) => {
    band.push(edge - EPS, DAY.bandColors[4 - i]);
  });
  const shallow = [
    "<",
    ["get", "DRVAL1"],
    ["-", ["global-state", "safetyDepth"], EPS],
  ];
  return {
    version: 8,
    // Plotters draw text in their own fonts and ignore this, but the style spec wants a
    // glyphs URL wherever a layer has text, and validating hosts refuse a style without.
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    state: {
      safetyDepth: { default: safetyDepth },
      // The SOUNDG label in the user's unit: `depth_m` or `depth_ft`.
      depthLabel: { default: "depth_m" },
      // Metres per the user's depth unit, for contour labels.
      metresPerUnit: { default: 1 },
    },
    sources: {
      cells: {
        type: "vector",
        tiles: [tiles],
        minzoom: MIN_ZOOM,
        maxzoom: MAX_ZOOM,
      },
      provisional: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
    },
    layers: [
      {
        id: "depare",
        type: "fill",
        source: "cells",
        "source-layer": "DEPARE",
        paint: {
          "fill-color": [
            "case",
            ["<", ["get", "DRVAL1"], 0],
            DAY.drying,
            shallow,
            DAY.hazard,
            band,
          ],
          "fill-opacity": 0.85,
        },
      },
      {
        id: "coverage",
        type: "fill",
        source: "cells",
        "source-layer": "M_QUAL",
        paint: {
          "fill-color": DAY.own,
          "fill-opacity": [
            "case",
            ["==", ["get", "kind"], "measured"],
            DAY.ownMeasured,
            DAY.ownInterpolated,
          ],
        },
      },
      {
        id: "depcnt",
        type: "line",
        source: "cells",
        "source-layer": "DEPCNT",
        paint: {
          "line-color": DAY.own,
          "line-width": 1.2,
          "line-opacity": 0.9,
        },
      },
      {
        id: "depcnt-label",
        type: "symbol",
        source: "cells",
        "source-layer": "DEPCNT",
        layout: {
          "symbol-placement": "line",
          "text-field": [
            "number-format",
            // Floored, as soundings are, so a label never reads deeper than the contour.
            [
              "floor",
              [
                "+",
                ["/", ["get", "VALDCO"], ["global-state", "metresPerUnit"]],
                1e-9,
              ],
            ],
            { "max-fraction-digits": 0 },
          ],
          "text-size": 10,
        },
        paint: {
          "text-color": DAY.own,
          "text-halo-color": DAY.labelHalo,
          "text-halo-width": 1,
        },
      },
      {
        id: "soundg",
        type: "symbol",
        source: "cells",
        "source-layer": "SOUNDG",
        layout: {
          "text-field": ["to-string", ["get", ["global-state", "depthLabel"]]],
          "text-size": 12,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": [
            "case",
            ["<", ["get", "VALSOU"], ["global-state", "safetyDepth"]],
            DAY.ownEmphasis,
            DAY.own,
          ],
          // An unconfirmed shoal is a warning, not a measured depth: drawn fainter.
          "text-opacity": ["case", ["has", "unconfirmed"], 0.7, 1],
          "text-halo-color": DAY.labelHalo,
          "text-halo-width": 1.5,
        },
      },
      {
        id: "provisional",
        type: "circle",
        source: "provisional",
        paint: {
          "circle-radius": 2.5,
          "circle-color": DAY.provisional,
          "circle-opacity": 0.8,
        },
      },
      {
        id: "provisional-label",
        type: "symbol",
        source: "provisional",
        minzoom: 14,
        layout: {
          "text-field": ["to-string", ["get", ["global-state", "depthLabel"]]],
          "text-size": 10,
          "text-offset": [0, 0.9],
        },
        paint: {
          "text-color": DAY.provisional,
          "text-halo-color": DAY.labelHalo,
          "text-halo-width": 1,
        },
      },
    ],
  };
}
