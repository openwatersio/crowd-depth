import { Readable } from "stream";
import { BathymetryData } from "../types.js";
import * as GeoJSON from "geojson";
import { JsonStreamStringify } from "json-stream-stringify";
import chain from "stream-chain";

/**
 * Converts BathymetryData objects into a GeoJSON FeatureCollection stream.
 */
export function toGeoJSON(data: Readable, additionalFields: object = {}) {
  const features = chain([data, toFeature]);

  const geojson = new JsonStreamStringify({
    type: "FeatureCollection",
    ...additionalFields,
    features,
  });

  features.on("error", (err) => geojson.destroy(err));

  return geojson;
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
      time: timestamp.toString({ smallestUnit: "millisecond" }),
    },
  };
}
