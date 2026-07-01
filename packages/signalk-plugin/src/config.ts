import { ServerAPI } from "@signalk/server-api";

// Can this be inferred from the JSON schema?
export type Config = {
  path: (typeof DepthPaths)[number];
  sounder: {
    x: number;
    y: number;
    z: number;
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
};

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
  const n2k = sources?.[label]?.[instance]?.n2k;
  const name = [n2k?.["Manufacturer Code"], n2k?.["Model ID"]]
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

export function schema(app: ServerAPI) {
  const defaultPath = DepthPaths.find((path) =>
    app.getSelfPath(`environment.depth.${path}.value`),
  );
  const positionSources = sourcesFor(app, "navigation.position");
  const depthSources = sourcesFor(app, `environment.depth.${defaultPath}`);
  return {
    type: "object",
    description:
      "By enabling this plugin, you agree to share your position and depth data with the IHO data collection service under the terms of Creative Commons 1.0 Universal public domain dedication (CCO).",
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
        required: ["x", "y", "z"],
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
    },
  };
}
