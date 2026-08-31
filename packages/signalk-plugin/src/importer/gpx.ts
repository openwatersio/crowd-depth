import { Temporal } from "@js-temporal/polyfill";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { BathymetryData } from "../types.js";

export type ParsedGpxPoint = Omit<BathymetryData, "timestamp"> & {
  timestamp?: Temporal.Instant;
};

export type ParsedGpx = {
  trackpoints: number;
  pointsWithoutDepth: number;
  points: ParsedGpxPoint[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (_name, path) => path.endsWith(".trkpt"),
  parseTagValue: false,
});

export function parseRaymarineGpx(xml: string): ParsedGpx {
  const validation = XMLValidator.validate(xml);
  if (validation !== true)
    throw new Error(
      `Invalid GPX XML at line ${validation.err.line}, column ${validation.err.col}: ${validation.err.msg}`,
    );

  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch (cause) {
    throw new Error("Invalid GPX XML", { cause });
  }

  const trackpoints = findValues(document, "trkpt");
  const points: ParsedGpxPoint[] = [];
  let pointsWithoutDepth = 0;

  for (const raw of trackpoints) {
    if (!isRecord(raw)) continue;
    const latitude = finiteNumber(raw["@_lat"]);
    const longitude = finiteNumber(raw["@_lon"]);
    if (
      latitude === undefined ||
      longitude === undefined ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new Error(
        `Invalid latitude/longitude in trackpoint ${points.length + pointsWithoutDepth + 1}`,
      );
    }

    const depthValue = findFirstValue(raw.extensions, "WaterDepth");
    const depth = finiteNumber(depthValue);
    if (depth === undefined || depth < 0) {
      pointsWithoutDepth += 1;
      continue;
    }

    const timeValue = findFirstValue(raw, "time");
    let timestamp: Temporal.Instant | undefined;
    if (typeof timeValue === "string" && timeValue.trim()) {
      try {
        timestamp = Temporal.Instant.from(timeValue.trim());
      } catch (cause) {
        throw new Error(
          `Invalid GPX timestamp in trackpoint ${points.length + pointsWithoutDepth + 1}: ${timeValue}`,
          { cause },
        );
      }
    }

    points.push({ latitude, longitude, depth, timestamp });
  }

  if (points.length === 0)
    throw new Error(
      "The GPX file contains no trackpoints with WaterDepth measurements",
    );

  return { trackpoints: trackpoints.length, pointsWithoutDepth, points };
}

function findValues(value: unknown, localName: string): unknown[] {
  if (Array.isArray(value))
    return value.flatMap((item) => findValues(item, localName));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === localName
      ? Array.isArray(child)
        ? child
        : [child]
      : findValues(child, localName),
  );
}

function findFirstValue(value: unknown, localName: string): unknown {
  return findValues(value, localName)[0];
}

function finiteNumber(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
