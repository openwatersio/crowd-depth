import { Temporal } from "@js-temporal/polyfill";
import type { BathymetryData } from "../types.js";
import type { ParsedGpx } from "./gpx.js";

export const DepthReferences = [
  "belowWaterline",
  "belowTransducer",
  "belowKeel",
] as const;
export type DepthReference = (typeof DepthReferences)[number];

export type ConversionOptions = {
  startedAt?: Temporal.Instant;
  interval?: Temporal.Duration;
  depthReference: DepthReference;
  transducerDepth?: number;
  draft?: number;
  maxPoints?: number;
  dedupeDistanceMeters?: number;
};

export type ConvertedGpx = {
  data: BathymetryData[];
  timestampSource: "gpx" | "cli" | "mixed";
  deduplicatedPoints: number;
};

export function convertGpx(
  parsed: ParsedGpx,
  options: ConversionOptions,
): ConvertedGpx {
  validateDepthReference(options);
  const hasTimestamps = parsed.points.map(
    (point) => point.timestamp !== undefined,
  );
  const missingTimestamps = hasTimestamps.some((present) => !present);
  if (missingTimestamps && (!options.startedAt || !options.interval)) {
    throw new Error(
      "GPX trackpoints are missing timestamps; provide both --started-at and --interval",
    );
  }
  if (options.interval && options.interval.total("milliseconds") <= 0)
    throw new Error("--interval must be greater than zero");

  let data = parsed.points.map((point, index): BathymetryData => ({
    latitude: point.latitude,
    longitude: point.longitude,
    depth: toWaterlineDepth(point.depth, options),
    timestamp:
      point.timestamp ??
      options.startedAt!.add({
        milliseconds: options.interval!.total("milliseconds") * index,
      }),
  }));

  const beforeDedupe = data.length;
  if (options.dedupeDistanceMeters !== undefined) {
    if (options.dedupeDistanceMeters < 0)
      throw new Error("--dedupe-distance-meters cannot be negative");
    data = dedupeByDistance(data, options.dedupeDistanceMeters);
  }
  const deduplicatedPoints = beforeDedupe - data.length;
  if (options.maxPoints !== undefined) {
    if (!Number.isInteger(options.maxPoints) || options.maxPoints <= 0)
      throw new Error("--max-points must be a positive integer");
    data = data.slice(0, options.maxPoints);
  }

  return {
    data,
    timestampSource: hasTimestamps.every(Boolean)
      ? "gpx"
      : hasTimestamps.some(Boolean)
        ? "mixed"
        : "cli",
    deduplicatedPoints,
  };
}

function validateDepthReference(options: ConversionOptions) {
  if (
    options.depthReference === "belowTransducer" &&
    (options.transducerDepth === undefined || options.transducerDepth < 0)
  )
    throw new Error(
      "belowTransducer requires a non-negative --transducer-depth to convert depths to the waterline reference",
    );
  if (
    options.depthReference === "belowKeel" &&
    (options.draft === undefined || options.draft < 0)
  )
    throw new Error(
      "belowKeel requires a non-negative --draft to convert depths to the waterline reference",
    );
}

function toWaterlineDepth(depth: number, options: ConversionOptions) {
  switch (options.depthReference) {
    case "belowWaterline":
      return depth;
    case "belowTransducer":
      return depth + options.transducerDepth!;
    case "belowKeel":
      return depth + options.draft!;
  }
}

function dedupeByDistance(points: BathymetryData[], meters: number) {
  if (meters === 0) return points;
  const result: BathymetryData[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (!previous || distanceMeters(previous, point) >= meters)
      result.push(point);
  }
  return result;
}

function distanceMeters(a: BathymetryData, b: BathymetryData) {
  const radians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLon = (b.longitude - a.longitude) * radians;
  const lat1 = a.latitude * radians;
  const lat2 = b.latitude * radians;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function parseInterval(value: string): Temporal.Duration {
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)$/);
  if (!match)
    throw new Error(
      `Invalid interval "${value}"; use e.g. 500ms, 1s, 2m, or 1h`,
    );
  const milliseconds =
    Number(match[1]) *
    ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]]!);
  if (!Number.isInteger(milliseconds) || milliseconds <= 0)
    throw new Error(
      "--interval must resolve to a positive whole number of milliseconds",
    );
  return Temporal.Duration.from({ milliseconds });
}
