import { detectSensor, sourceDevice, sameSource } from "./device-info.js";
import { ServerAPI } from "@signalk/server-api";
import { DEFAULT_OWN_STYLE, TINTS, type Tint } from "./tiles/style.js";

// Can this be inferred from the JSON schema?
export type Config = {
  /** Resolved internally at startup; not a user setting. */
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
  /** Origin of server-corrected positions, distinct from the physical antenna. */
  positionOrigin?: { x: number; y: number };
  sharing: {
    anonymous: boolean;
  };
  chart?: {
    /** Offer the "My soundings" layer to chartplotters; on unless turned off. */
    show?: boolean;
    /** Depth areas and soundings shoaler than this, in metres, draw as unsafe. */
    safetyDepth?: number;
    /** Recency weighting of the rendered layer, independent of data retention. */
    halfLifeDays?: number;
    /** The colour of the boat's own soundings, contours and tint, as `#rrggbb`. */
    color?: string;
    /** The colour of soundings shoaler than the safety depth, as `#rrggbb`. */
    shoalColor?: string;
    /** How strongly the water the boat sounded is tinted. */
    tint?: Tint;
    /** Draw depth contours; on unless turned off. */
    contours?: boolean;
    /** Contours every metre and every foot zoomed in, or the chart's isobaths. */
    contourDetail?: "high" | "standard";
  };
};

/**
 * The source Signal K currently prioritizes for a path (its `$source`) plus the
 * full list of sources that have reported it. Used to default and populate the
 * source selectors so soundings stay pinned to one sensor rather than mixing
 * antenna offsets from multiple GPS sources.
 */
export function sourcesFor(app: ServerAPI, path: string) {
  const node = app.getSelfPath?.(path) as
    { $source?: string; values?: Record<string, unknown> } | undefined;
  const selected = node?.$source;
  // Multi-source paths carry a `values` map keyed by sourceRef; single-source
  // paths have none, so fall back to the active `$source`. Either way, make sure
  // the active source is in the list.
  const available = node?.values ? Object.keys(node.values) : [];
  if (selected && !available.includes(selected)) available.unshift(selected);
  return { selected, available };
}

/** Source refs returned by the History API, indexed by Signal K path. */
export type RecordedSources = Record<string, string[]>;

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
 * enumNames. When nothing has reported the path yet the enum is empty and the
 * description explains when neither live nor recorded sources are available.
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
      : `No live or recorded ${noun} sources found. Check the history provider or reload this page once data is being received.`,
  };
}

export const DepthPaths = [
  "belowTransducer",
  "belowSurface",
  "belowKeel",
] as const;

/** Pick one path for one source; never borrow availability from another sensor. */
export function selectDepth(
  app: ServerAPI,
  source: string | undefined,
  recorded: RecordedSources = {},
  savedPath?: Config["path"],
) {
  const candidates = savedPath ? [savedPath] : DepthPaths;
  const paths = candidates.map((path) => ({
    path,
    ...sourcesFor(app, `environment.depth.${path}`),
    recorded: recorded[`environment.depth.${path}`] ?? [],
  }));
  const available = [
    ...new Set(paths.flatMap((p) => [...p.available, ...p.recorded])),
  ].filter((s) => s !== "derived-data");
  const selected =
    source && source !== "derived-data"
      ? source
      : (paths.find((p) => p.selected && p.selected !== "derived-data")
          ?.selected ?? (available.length === 1 ? available[0] : undefined));
  if (!selected) return;
  const path = paths.find((p) =>
    [...p.available, ...p.recorded].some((ref) =>
      sameSource(app, ref, selected),
    ),
  )?.path;
  return path ? { path, source: selected } : undefined;
}

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

export function schema(app: ServerAPI, recorded: RecordedSources = {}) {
  const saved = (
    app.readPluginOptions?.() as { configuration?: Partial<Config> }
  )?.configuration;
  function choices(paths: string[], configured?: string) {
    const live = paths.map((path) => sourcesFor(app, path));
    const available = [
      ...new Set([
        ...(configured ? [configured] : []),
        ...live.flatMap((source) => source.available),
        ...paths.flatMap((path) => recorded[path] ?? []),
      ]),
    ].filter((source) => source !== "derived-data");
    return {
      available,
      selected:
        (configured && available.includes(configured)
          ? configured
          : undefined) ||
        (live[0]?.selected && available.includes(live[0].selected)
          ? live[0].selected
          : undefined) ||
        (available.length === 1 ? available[0] : undefined),
    };
  }
  const positionSources = choices(["navigation.position"], saved?.gnss?.source);
  // Include every depth path: changing Path in the form doesn't regenerate
  // its schema, and a derived path can have a different source from the sounder.
  const depthPaths = DepthPaths.map((path) => `environment.depth.${path}`);
  const depthSources = choices(depthPaths, saved?.sounder?.source);
  return {
    type: "object",
    description:
      "By enabling this plugin, you agree to share your soundings and your vessel and sensor details, and you dedicate them to the public domain under Creative Commons CC0 1.0 Universal.",
    properties: {
      sounder: {
        type: "object",
        title: "Depth Sounder",
        // The transducer depth may be unknown; depths are then reported as
        // measured from the transducer rather than the waterline.
        required: ["x", "y"],
        properties: {
          source: sourceSchema(app, "Depth source", "depth", depthSources),
          make: {
            type: "string",
            title: "Make",
          },
          model: {
            type: "string",
            title: "Model",
          },
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
          frequency: {
            type: "number",
            title: "Frequency",
            description:
              "The frequency of the sounder in Hz. Standard NMEA device information does not provide this; leave blank if unknown.",
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
        description:
          "Horizontal antenna offsets come from Signal K’s per-source GNSS sensor settings. Restart this plugin after changing them.",
        properties: {
          source: sourceSchema(
            app,
            "Position source",
            "position",
            positionSources,
          ),
          make: {
            type: "string",
            title: "Make",
          },
          model: {
            type: "string",
            title: "Model",
          },
          z: {
            type: "number",
            title: "Distance of the antenna above the waterline (meters)",
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
          halfLifeDays: {
            type: "number",
            default: 365,
            minimum: 1,
            maximum: 36500,
            title: "Sounding weight half-life (days)",
            description:
              "An observation this old has half the weight of a new one. Larger values retain more historical influence. This does not delete observations.",
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

/** Placeholders are hints, not defaults saved as manual overrides. */
export function uiSchema(app: ServerAPI, recorded: RecordedSources = {}) {
  const settings = schema(app, recorded).properties;
  const sounder = detectSensor(
    app,
    settings.sounder.properties.source.default,
    true,
  );
  const gnss = detectSensor(app, settings.gnss.properties.source.default, true);
  return {
    sounder: {
      make: { "ui:placeholder": sounder.make ?? "" },
      model: { "ui:placeholder": sounder.model ?? "" },
    },
    gnss: {
      make: { "ui:placeholder": gnss.make ?? "" },
      model: { "ui:placeholder": gnss.model ?? "" },
    },
  };
}
