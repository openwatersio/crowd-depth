import type { ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";
import { sameSource } from "./device-info.js";

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
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function liveGnssQuality(
  app: ServerAPI,
  source: string | undefined,
  time: Temporal.Instant,
): GnssQuality | undefined {
  if (!source) return;
  const result: GnssQuality = {};
  for (const field of Object.keys(
    GNSS_FIELDS,
  ) as (keyof typeof GNSS_FIELDS)[]) {
    type Sample = { value?: unknown; timestamp?: string };
    const node = app.getSelfPath(`navigation.gnss.${field}`) as
      | (Sample & { $source?: string; values?: Record<string, Sample> })
      | undefined;
    const samples = Object.entries(node?.values ?? {})
      .filter(([ref]) => sameSource(app, ref, source))
      .map(([, sample]) => sample);
    if (node && sameSource(app, node.$source, source)) samples.unshift(node);
    let youngest = Infinity;
    for (const sample of samples) {
      if (!sample?.timestamp) continue;
      let age: number;
      try {
        age =
          time.epochMilliseconds -
          Temporal.Instant.from(sample.timestamp).epochMilliseconds;
      } catch {
        continue;
      }
      if (age < 0 || age > 2000 || age >= youngest) continue;
      const value = qualityValue(field, sample.value);
      if (value !== undefined) {
        result[field] = value;
        youngest = age;
      }
    }
  }
  return Object.keys(result).length ? result : undefined;
}
