import { Transform } from "stream";
import { BathymetryData } from "../types.js";
import { parse } from "csv-parse";
import { Temporal } from "@js-temporal/polyfill";

/**
 * Converts BathymetryData to XYZ format.
 * https://www.ncei.noaa.gov/sites/g/files/anmtlf171/files/2024-04/GuidanceforSubmittingCSBDataToTheIHODCDB%20%281%29.pdf
 */
export function toXyz({
  header = true,
  includeHeading = true,
}: { header?: boolean; includeHeading?: boolean } = {}) {
  return new Transform({
    readableObjectMode: false,
    writableObjectMode: true,
    construct(callback) {
      if (header) {
        const fields = ["LON", "LAT", "DEPTH", "TIME"];
        if (includeHeading) fields.push("HEAD");
        this.push(fields.join(",") + "\n");
      }
      callback();
    },
    transform(data: BathymetryData, encoding, callback) {
      const { latitude, longitude, depth, timestamp, heading } = data;
      try {
        const fields = [
          longitude,
          latitude,
          depth,
          timestamp.toString({ smallestUnit: "millisecond" }),
        ];
        if (includeHeading) fields.push(heading ?? "");
        this.push(fields.join(",") + "\n");
        callback();
      } catch (err) {
        return callback(err as Error);
      }
    },
  });
}

const XyzToBathymetry = {
  LAT: "latitude",
  LON: "longitude",
  DEPTH: "depth",
  TIME: "timestamp",
  HEAD: "heading",
};

export function fromXyz() {
  return parse({
    cast_date: true,
    skip_empty_lines: true,
    skip_records_with_empty_values: true,
    skip_records_with_error: true,
    columns(header: (keyof typeof XyzToBathymetry)[]) {
      return header.map((key) => XyzToBathymetry[key] || key);
    },
    cast(value, context) {
      if (context.header) return value;
      if (value === "") return undefined;
      if (context.column === "timestamp") {
        return Temporal.Instant.from(value);
      } else {
        return Number(value);
      }
    },
  });
}
