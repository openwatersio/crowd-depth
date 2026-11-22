import { sameSource, sourceDevice } from "./device-info.js";
import type { ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";

// Preserve Signal K names and SI units in the report's gnss extension.
export const GNSS_FIELDS = {
  type: "string",
  methodQuality: "string",
  integrity: "string",
  satellites: "number",
  antennaAltitude: "number",
  horizontalDilution: "number",
  positionDilution: "number",
  geoidalSeparation: "number",
  differentialAge: "number",
  differentialReference: "number",
} as const;
export type GnssQuality = Partial<
  Record<keyof typeof GNSS_FIELDS, string | number>
>;
export function qualityValue(field: keyof typeof GNSS_FIELDS, value: unknown) {
  if (GNSS_FIELDS[field] === "number")
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  return typeof value === "string" && value.length <= 128 && value.trim()
    ? value
    : undefined;
}

export function liveGnssQuality(
  app: ServerAPI,
  source: string | undefined,
  time: Temporal.Instant,
): GnssQuality | undefined {
  if (!source) return;
  if (source.endsWith(".ccrp")) {
    const sensors = (
      app as ServerAPI & {
        config?: {
          settings?: { gnssSensors?: { sensorId: string; $source: string }[] };
        };
      }
    ).config?.settings?.gnssSensors;
    source = sensors?.find(
      (sensor) => `${sensor.sensorId}.ccrp` === source,
    )?.$source;
    if (!source) return;
  }
  const result: GnssQuality = {};
  for (const field of Object.keys(
    GNSS_FIELDS,
  ) as (keyof typeof GNSS_FIELDS)[]) {
    type Sample = { value?: unknown; timestamp?: string };
    const node = app.getSelfPath(`navigation.gnss.${field}`) as
      | (Sample & { $source?: string; values?: Record<string, Sample> })
      | undefined;
    const sample = sameSource(app, node?.$source, source)
      ? node
      : Object.entries(node?.values ?? {}).find(([ref]) =>
          sameSource(app, ref, source),
        )?.[1];
    if (!sample?.timestamp) continue;
    try {
      const age =
        time.epochMilliseconds -
        Temporal.Instant.from(sample.timestamp).epochMilliseconds;
      if (age < 0 || age > 2000) continue;
    } catch {
      continue;
    }
    const value = qualityValue(field, sample.value);
    if (value !== undefined) result[field] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Canonicalize only aliases known on this connection. */
export function qualitySource(app: ServerAPI, source: string) {
  const name = sourceDevice(app, source)?.canName;
  return typeof name === "string" && source.includes(".")
    ? `${source.slice(0, source.indexOf("."))}.${name}`
    : source;
}
