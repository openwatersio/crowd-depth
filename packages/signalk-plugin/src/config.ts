import { ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";
import { DEFAULT_OWN_STYLE, TINTS, type Tint } from "./tiles/style.js";

// Can this be inferred from the JSON schema?
export type Config = {
  path: (typeof DepthPaths)[number];
  sounder: {
    x: number;
    y: number;
    /** Depth of the transducer below the waterline; unknown when unset. */
    z?: number;
    draft?: number;
    make?: string;
    model?: string;
    frequency?: number;
    transducer?: string;
    source?: string;
  };
  gnss: {
    x: number;
    y: number;
    z: number;
    make?: string;
    model?: string;
    source?: string;
  };
  sharing: {
    anonymous: boolean;
  };
  chart?: {
    /** Offer the "My soundings" layer to chartplotters; on unless turned off. */
    show?: boolean;
    /** Depth areas and soundings shoaler than this, in metres, draw as unsafe. */
    safetyDepth?: number;
    /** The colour of the boat's own soundings, contours and tint, as `#rrggbb`. */
    color?: string;
    /** The colour of soundings shoaler than the safety depth, as `#rrggbb`. */
    shoalColor?: string;
    /** How strongly the water the boat sounded is tinted. */
    tint?: Tint;
    /** Draw depth contours; on unless turned off. */
    contours?: boolean;
    /** How far back the layer fills from the plugin's source. */
    history?: History;
    /** Contours every metre and every foot zoomed in, or the chart's isobaths. */
    contourDetail?: "high" | "standard";
  };
};

/** The spans the layer can fill from, in days; all of the source's history for "all". */
export const HISTORY_DAYS = { month: 30, year: 365, all: undefined };
export type History = keyof typeof HISTORY_DAYS;
export const DEFAULT_HISTORY: History = "year";

/** The history setting, a hand-edited value that isn't one falling back to the default. */
export function historySetting(config: Config): History {
  const history = config.chart?.history;
  return history && Object.hasOwn(HISTORY_DAYS, history)
    ? history
    : DEFAULT_HISTORY;
}

/** How far back the layer fills; undefined for all of it. */
export function historySpan(config: Config): Temporal.Duration | undefined {
  const days = HISTORY_DAYS[historySetting(config)];
  return days === undefined
    ? undefined
    : Temporal.Duration.from({ hours: days * 24 });
}

/**
 * The source Signal K currently prioritizes for a path (its `$source`) plus the
 * full list of sources that have reported it. Used to default and populate the
 * source selectors so soundings stay pinned to one sensor rather than mixing
 * antenna offsets from multiple GPS sources.
 */
export function sourcesFor(app: ServerAPI, path: string) {
  const node = app.getSelfPath(path) as
    { $source?: string; values?: Record<string, unknown> } | undefined;
  const selected = node?.$source;
  // Multi-source paths carry a `values` map keyed by sourceRef; single-source
  // paths have none, so fall back to the active `$source`. Either way, make sure
  // the active source is in the list.
  const available = node?.values ? Object.keys(node.values) : [];
  if (selected && !available.includes(selected)) available.unshift(selected);
  return { selected, available };
}

/** Configured source if set, else the server's prioritized source, else undefined. */
export function resolveSource(
  app: ServerAPI,
  configured: string | undefined,
  path: string,
): string | undefined {
  return configured || sourcesFor(app, path).selected;
}

/**
 * A friendly label for a sourceRef, e.g. "Airmar DST200 (PICAN-M.35)", built
 * from the NMEA 2000 device info Signal K keeps under `sources`. Falls back to
 * the raw sourceRef when no device details are known.
 */
function sourceLabel(app: ServerAPI, sourceRef: string): string {
  const dot = sourceRef.indexOf(".");
  const label = dot === -1 ? sourceRef : sourceRef.slice(0, dot);
  const instance = dot === -1 ? "" : sourceRef.slice(dot + 1);
  const sources = app.getPath("sources") as
    | Record<string, Record<string, { n2k?: Record<string, unknown> }>>
    | undefined;
  const connection = sources?.[label];
  // The sources tree keys devices by numeric bus address, but with
  // useCanName the sourceRef carries the hex CAN name instead, so fall
  // back to matching each device's n2k.canName (mirrors the admin UI's
  // getDeviceInfo in signalk-server's sourceLabels.ts).
  const n2k =
    connection?.[instance]?.n2k ??
    Object.values(connection ?? {}).find(
      (device) => device?.n2k?.canName === instance,
    )?.n2k;
  const name = [n2k?.manufacturerCode, n2k?.modelId]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ");
  return name ? `${name} (${sourceRef})` : sourceRef;
}

/**
 * Schema for a source selector. Always an enum, with friendly device names via
 * enumNames. When nothing has reported the path yet the enum is empty and the
 * description warns that no data is available so the empty dropdown isn't a
 * mystery.
 */
function sourceSchema(
  app: ServerAPI,
  title: string,
  noun: string,
  sources: ReturnType<typeof sourcesFor>,
) {
  return {
    type: "string",
    title,
    enum: sources.available,
    enumNames: sources.available.map((source) => sourceLabel(app, source)),
    default: sources.selected,
    description: sources.available.length
      ? `The ${noun} source to record. Defaults to the source Signal K prioritizes; choose one when the vessel has more than one.`
      : `No ${noun} data available — reload this page once it is being received.`,
  };
}

export const DepthPaths = [
  "belowSurface",
  "belowTransducer",
  "belowKeel",
] as const;

/** The CSB `verticalReferenceOfDepth` values (IHO B-12 Table 1). */
export type VerticalReference = "Waterline" | "Transducer" | "Unknown";

/**
 * What to add to the recorded depth to measure it from the waterline, and
 * what the result is then measured from. When the offset that would get it to
 * the waterline is not configured, the depth is left as recorded and labelled
 * by what it is actually measured from, rather than claiming the waterline.
 */
export function depthReference(config: Pick<Config, "path" | "sounder">): {
  offset: number;
  reference: VerticalReference;
} {
  switch (config.path) {
    case "belowSurface":
      return { offset: 0, reference: "Waterline" };
    case "belowTransducer":
      return config.sounder?.z !== undefined &&
        Number.isFinite(config.sounder.z)
        ? { offset: config.sounder.z, reference: "Waterline" }
        : { offset: 0, reference: "Transducer" };
    case "belowKeel":
      return Number.isFinite(config.sounder?.draft)
        ? { offset: config.sounder.draft!, reference: "Waterline" }
        : { offset: 0, reference: "Unknown" };
    default:
      return { offset: 0, reference: "Unknown" };
  }
}

export function schema(app: ServerAPI) {
  const defaultPath = DepthPaths.find((path) =>
    app.getSelfPath(`environment.depth.${path}.value`),
  );
  const positionSources = sourcesFor(app, "navigation.position");
  const depthSources = defaultPath
    ? sourcesFor(app, `environment.depth.${defaultPath}`)
    : { selected: undefined, available: [] };
  return {
    type: "object",
    description:
      "By enabling this plugin, you agree to share your soundings and your vessel and sensor details, and you dedicate them to the public domain under Creative Commons CC0 1.0 Universal.",
    properties: {
      path: {
        type: "string",
        title: "Path",
        description:
          "The path to the depth data. (e.g. environment.depth.belowTransducer)",
        enum: DepthPaths,
        default: defaultPath,
      },
      sounder: {
        type: "object",
        title: "Depth Sounder",
        // The transducer depth may be unknown; depths are then reported as
        // measured from the transducer rather than the waterline.
        required: ["x", "y"],
        properties: {
          source: sourceSchema(app, "Depth source", "depth", depthSources),
          y: {
            type: "number",
            title: "Distance of the transducer from the bow (meters)",
            minimum: 0,
            default: app.getSelfPath("sensors.depth.fromBow.value"),
          },
          x: {
            type: "number",
            title: "Distance of the transducer from the center (meters)",
            description: "+ve to starboard, -ve to port",
            default: app.getSelfPath("sensors.depth.fromCenter.value"),
          },
          z: {
            type: "number",
            title: "Distance of the transducer below the waterline (meters)",
            description:
              "Leave empty if unknown: depths below the transducer are then shared as measured from the transducer, not the waterline.",
            default: app.getSelfPath(
              "environment.depth.surfaceToTransducer.value",
            ),
          },
          draft: {
            type: "number",
            title: "Draft",
            description: "The draft of the vessel in meters.",
            default: app.getSelfPath("design.draft.value"),
          },
          make: {
            type: "string",
            title: "Make",
            description: "The manufacturer of the sounder. (e.g. Raymarine)",
          },
          model: {
            type: "string",
            title: "Model",
            description: "The model of the sounder. (e.g. ST60+)",
          },
          frequency: {
            type: "number",
            title: "Frequency",
            description: "The frequency of the sounder in Hz.",
          },
          transducer: {
            type: "string",
            title: "Transducer",
            description: "The transducer used by the sounder.",
          },
        },
      },
      gnss: {
        type: "object",
        title: "GPS Receiver",
        required: ["x", "y", "z"],
        properties: {
          source: sourceSchema(
            app,
            "Position source",
            "position",
            positionSources,
          ),
          y: {
            type: "number",
            title: "Distance of the antenna from the bow (meters)",
            minimum: 0,
            default: app.getSelfPath("sensors.gps.fromBow.value"),
          },
          x: {
            type: "number",
            title: "Distance of the antenna from the center (meters)",
            description: "+ve to starboard, -ve to port",
            default: app.getSelfPath("sensors.gps.fromCenter.value"),
          },
          z: {
            type: "number",
            title: "Distance of the antenna above the waterline (meters)",
          },
          make: {
            type: "string",
            title: "Make",
            description:
              "The manufacturer of the GPS receiver. (e.g. Kongsberg Maritime)",
          },
          model: {
            type: "string",
            title: "Model",
            description: "The model of the GPS Receiver. (e.g. Seapath 330+)",
          },
        },
      },
      sharing: {
        type: "object",
        title: "Data Sharing",
        properties: {
          anonymous: {
            type: "boolean",
            default: false,
            title: "Share data anonymously",
            description:
              "If you do not wish to share your vessel name and MMSI, you can share anonymously with a unique UUID instead.",
          },
        },
      },
      chart: {
        type: "object",
        title: "Chart",
        properties: {
          show: {
            type: "boolean",
            default: true,
            title: "Show my soundings on the chart",
            description:
              "Draw the depths this boat records as a layer in chartplotters that support Signal K plotter extensions, such as Freeboard-SK 3.4 or later. With signalk-tides installed, depths are reduced to chart datum by predicted tides where a station is in reach. Not for navigation.",
          },
          safetyDepth: {
            type: "number",
            default: 3,
            minimum: 0,
            title: "Safety depth (m)",
            description:
              "Depth areas and soundings shoaler than this draw as unsafe on the layer.",
          },
          color: {
            type: "string",
            format: "color",
            default: DEFAULT_OWN_STYLE.accent,
            title: "Colour of my soundings",
            description:
              "The colour of the layer's soundings, contours and tint. Pick one the chart under it doesn't use, so the layer stands out.",
          },
          shoalColor: {
            type: "string",
            format: "color",
            default: DEFAULT_OWN_STYLE.shoal,
            title: "Colour of my shoal soundings",
            description:
              "The colour of soundings shoaler than the safety depth. Pick one that stands apart from the colour of my soundings.",
          },
          tint: {
            type: "string",
            enum: Object.keys(TINTS),
            enumNames: ["Off", "Faint", "Normal", "Strong"],
            default: DEFAULT_OWN_STYLE.tint,
            title: "Tint over sounded water",
            description:
              "How strongly the layer tints the water this boat has sounded, and half as strongly where it fills in between tracks.",
          },
          contours: {
            type: "boolean",
            default: DEFAULT_OWN_STYLE.contours,
            title: "Draw depth contours",
          },
          history: {
            type: "string",
            enum: Object.keys(HISTORY_DAYS),
            enumNames: [
              "The last 30 days",
              "The last year",
              "All recorded history",
            ],
            default: DEFAULT_HISTORY,
            title: "Fill the layer from",
            description:
              "How far back the layer fills in from recorded soundings when it starts or rebuilds. A longer span takes longer to fill in, and new soundings wait for it, for up to 3 hours. Changing it rebuilds the layer.",
          },
          contourDetail: {
            type: "string",
            enum: ["high", "standard"],
            enumNames: [
              "High: every metre or foot, zoomed in",
              "Standard: the chart's isobaths",
            ],
            default: "high",
            title: "Contour detail",
            description:
              "High draws a contour every metre, or every foot, with every fifth one bold, from zoom 13 in; zoomed out, and at Standard, the layer draws the chart's isobaths.",
          },
        },
      },
    },
  };
}
