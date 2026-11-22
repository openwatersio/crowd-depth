import { detectSensor, sourceDevice } from "./device-info.js";
import { cachedGpsdSensor } from "./gpsd-info.js";
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
    /** Legacy saved geometry; new installations configure it in Signal K. */
    x?: number;
    y?: number;
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
 * full list of sources that have reported it. Used for device choices and
 * identity hints; an empty configured source follows server preference.
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
  const n2k = sourceDevice(app, sourceRef);
  const name = [n2k?.manufacturerCode, n2k?.modelId]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ");
  return name ? `${name} (${sourceRef})` : sourceRef;
}

/**
 * Schema for a source selector. Always an enum, with friendly device names via
 * enumNames. Preferred source is always available, including before sensors
 * have reported any data.
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
    enum: ["", ...sources.available],
    enumNames: [
      "Preferred source",
      ...sources.available.map((source) => sourceLabel(app, source)),
    ],
    default: sources.selected ?? "",
    description: `Follow Signal K's preferred ${noun} source, or select a specific device. For recorded data, Preferred source uses the history provider's default series.`,
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

/**
 * The plugin's config schema. Defaults read from the vessel's data are
 * undefined until that data arrives; the server stores the schema as JSON,
 * which would drop those keys anyway, so they are left out.
 */
export function schema(app: ServerAPI) {
  return withoutUndefined(buildSchema(app));
}

function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, withoutUndefined(v)]),
  ) as T;
}

function buildSchema(app: ServerAPI) {
  const depthFromCenter = app.getSelfPath("sensors.depth.fromCenter.value");
  const saved = (
    app.readPluginOptions?.() as { configuration?: Partial<Config> } | undefined
  )?.configuration;
  const defaultPath =
    saved?.path ??
    DepthPaths.find(
      (path) =>
        app.getSelfPath(`environment.depth.${path}.value`) !== undefined,
    );
  function choices(path: string, configured?: string) {
    const sources = sourcesFor(app, path);
    if (configured && !sources.available.includes(configured))
      sources.available.unshift(configured);
    return {
      available: sources.available.filter(
        (source) => source !== "derived-data" || source === configured,
      ),
      selected: configured ?? "",
    };
  }
  const positionSources = choices("navigation.position", saved?.gnss?.source);
  const depthSources = choices(
    `environment.depth.${defaultPath}`,
    saved?.sounder?.source,
  );
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
            default:
              typeof depthFromCenter === "number"
                ? -depthFromCenter
                : undefined,
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
        required: ["z"],
        properties: {
          source: sourceSchema(
            app,
            "Position source",
            "position",
            positionSources,
          ),
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
              "Share with a unique UUID instead of vessel name and MMSI.",
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

/** Hints only: opening the form must not save detected values as overrides. */
export function uiSchema(app: ServerAPI) {
  const defaults = schema(app).properties;
  const sounderSource = resolveSource(
    app,
    defaults.sounder.properties.source.default,
    `environment.depth.${defaults.path.default}`,
  );
  const gpsSource = resolveSource(
    app,
    defaults.gnss.properties.source.default,
    "navigation.position",
  );
  const sounder = detectSensor(app, sounderSource);
  const gnss = detectSensor(app, gpsSource);
  const gpsd = gnss.make || gnss.model ? {} : cachedGpsdSensor(app, gpsSource);
  return {
    sounder: {
      make: { "ui:placeholder": sounder.make ?? "" },
      model: { "ui:placeholder": sounder.model ?? "" },
    },
    gnss: {
      make: { "ui:placeholder": gnss.make ?? gpsd.make ?? "" },
      model: { "ui:placeholder": gnss.model ?? "" },
    },
  };
}
