// The live layer's MapLibre style: S-57 DEPARE, DEPCNT, SOUNDG and M_QUAL. Its depth
// areas are in Seascape's day palette (openwatersio/seascape style/flavor.ts), so depths
// read as the chart's do, but drawn over a chart in that palette, such as Seamap, they'd
// vanish into it: its soundings, contours and the water the boat sounded itself are
// drawn in a colour of their own. The depth unit is a `global-state` variable the
// runtime sets; the safety depth and the boat's own colours and tint are ones whose
// defaults come from the plugin's settings.
import { DEFINITIONS } from "./geometry.js";
import { MAX_ZOOM, MIN_ZOOM } from "./surface.js";

const P = DEFINITIONS.portrayal;

// Self-hosted (openwatersio/tile-fonts), the glyph server Seascape and Seamap use. Text
// is set in Seascape's faces: Medium for contour labels, Medium Italic for depths.
const GLYPHS = "https://tiles.openwaters.io/fonts/{fontstack}/{range}.pbf";
const LABEL_FONT = ["Noto Sans Medium"];
const DEPTH_FONT = ["Noto Sans Medium Italic"];

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
  // Tint over the water the boat sounded, and fainter over what's interpolated, at
  // the "normal" strength.
  ownMeasured: 0.14,
  ownInterpolated: 0.07,
};

/** How the boat's own data is drawn, from the plugin's settings. */
export interface OwnStyle {
  /** Soundings, contours and the tint, as `#rrggbb`. */
  accent: string;
  /** Soundings shoaler than the safety depth, as `#rrggbb`. */
  shoal: string;
  tint: Tint;
  contours: boolean;
}

export const TINTS = { off: 0, faint: 0.5, normal: 1, strong: 2 };
export type Tint = keyof typeof TINTS;

/** The boat's own data, in a colour no chart in Seascape's palette uses for depths. */
export const DEFAULT_OWN_STYLE: OwnStyle = {
  accent: "#7b2cbf",
  shoal: "#3c096c",
  tint: "normal",
  contours: true,
};

/** Small float error in a safety depth set on a band edge stays inside the band. */
const EPS = 0.01;

export function buildStyle({
  tiles,
  safetyDepth,
  own = DEFAULT_OWN_STYLE,
}: {
  tiles: string;
  safetyDepth: number;
  own?: OwnStyle;
}) {
  // The chart's band colours at their lower edges, blended between, so metre bands
  // shade evenly and the chart's bands keep their colours.
  const band: unknown[] = [
    "interpolate",
    ["linear"],
    ["get", "DRVAL1"],
    0,
    DAY.bandColors[5],
  ];
  [...DAY.bandEdges].reverse().forEach((edge, i) => {
    band.push(edge, DAY.bandColors[4 - i]);
    // The chart's levels between these edges, as 30 m, keep their band's colour.
    const next = [...DAY.bandEdges].reverse()[i + 1];
    for (const l of P.isobaths_m) {
      if (l > edge && next !== undefined && l < next)
        band.push(l, DAY.bandColors[4 - i]);
    }
  });
  // A contour in the other unit than the user's isn't drawn; one of every five, or
  // the chart's isobaths, which have no unit, are drawn bold and labelled.
  const otherUnit = [
    "all",
    ["has", "unit"],
    ["!=", ["get", "unit"], ["global-state", "contourUnit"]],
  ];
  const major = ["any", ["!", ["has", "unit"]], ["has", "major"]];
  const shallow = [
    "<",
    ["get", "DRVAL1"],
    ["-", ["global-state", "safetyDepth"], EPS],
  ];
  return {
    version: 8,
    // Plotters that draw text in their own fonts ignore this, but the style spec wants a
    // glyphs URL wherever a layer has text, and validating hosts refuse a style without.
    glyphs: GLYPHS,
    state: {
      safetyDepth: { default: safetyDepth },
      // The SOUNDG label in the user's unit: `depth_m` or `depth_ft`.
      depthLabel: { default: "depth_m" },
      // Metres per the user's depth unit, for contour labels.
      metresPerUnit: { default: 1 },
      // The unit of the fine contours drawn: `m` or `ft`.
      contourUnit: { default: "m" },
      ownColor: { default: own.accent },
      ownShoal: { default: own.shoal },
      ownTint: { default: TINTS[own.tint] },
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
          "fill-color": ["global-state", "ownColor"],
          "fill-opacity": [
            "*",
            ["global-state", "ownTint"],
            [
              "case",
              ["==", ["get", "kind"], "measured"],
              DAY.ownMeasured,
              DAY.ownInterpolated,
            ],
          ],
        },
      },
      {
        id: "depcnt",
        type: "line",
        source: "cells",
        "source-layer": "DEPCNT",
        paint: {
          "line-color": ["global-state", "ownColor"],
          "line-width": ["case", major, 1.2, 0.6],
          "line-opacity": ["case", otherUnit, 0, major, 0.9, 0.35],
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
            "case",
            ["any", otherUnit, ["!", major]],
            "",
            [
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
          ],
          "text-font": LABEL_FONT,
          "text-size": 10,
        },
        paint: {
          "text-color": ["global-state", "ownColor"],
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
          "text-font": DEPTH_FONT,
          "text-size": 12,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": [
            "case",
            ["<", ["get", "VALSOU"], ["global-state", "safetyDepth"]],
            ["global-state", "ownShoal"],
            ["global-state", "ownColor"],
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
          "text-font": DEPTH_FONT,
          "text-size": 10,
          "text-offset": [0, 0.9],
        },
        paint: {
          "text-color": DAY.provisional,
          "text-halo-color": DAY.labelHalo,
          "text-halo-width": 1,
        },
      },
      // Left out rather than hidden, as visibility takes no `global-state`, so turning
      // contours on or off shows once the plotter loads the style again.
    ].filter((layer) => own.contours || !layer.id.startsWith("depcnt")),
  };
}
