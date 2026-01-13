import { Readable } from "stream";
import { BathymetryData } from "../types.js";
import * as GeoJSON from "geojson";
import { JsonStreamStringify } from "json-stream-stringify";
import chain from "stream-chain";

/**
 * Converts BathymetryData objects into a GeoJSON FeatureCollection stream.
 */
export function toGeoJSON(data: Readable, additionalProperties: object = {}) {
  return new JsonStreamStringify({
    type: "FeatureCollection",
    ...additionalProperties,
    features: chain([data, toFeature]),
  });
}

/** Converts a Bathymetry data point to a GeoJSON Feature */
export function toFeature({
  latitude,
  longitude,
  depth,
  timestamp,
}: BathymetryData): GeoJSON.Feature {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [longitude, latitude],
    },
    properties: {
      depth: depth,
      time: timestamp.toISOString(),
    },
  };
}
