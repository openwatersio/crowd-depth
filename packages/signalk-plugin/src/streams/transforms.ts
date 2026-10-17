import { BathymetryData } from "../types.js";
import { computeDestinationPoint } from "geolib";
import { MIN_COG_SPEED } from "../tiles/core/correction.js";

export { MIN_COG_SPEED };

/**
 * Fix the precision of incoming data.
 *
 * coordinates - 7 decimal places = ~1.1cm.
 * depth - 3 decimal places = 1mm.
 * heading - 3 decimals = ~0.05 degrees.
 */
export function toPrecision({ coordinates = 7, depth = 3, heading = 3 } = {}) {
  return (data: BathymetryData) => {
    return {
      ...data,
      latitude: parseFloat(data.latitude.toFixed(coordinates)),
      longitude: parseFloat(data.longitude.toFixed(coordinates)),
      depth: parseFloat(data.depth.toFixed(depth)),
      heading:
        data.heading !== undefined
          ? parseFloat(data.heading.toFixed(heading))
          : undefined,
    };
  };
}

export type SensorConfig = {
  gnss: { x: number; y: number };
  sounder: { x: number; y: number };
};

/**
 * The direction the bow points, in radians, for moving a sounding from the
 * antenna to the transducer: the heading when known, else the course over
 * ground while the vessel is making way, else undefined.
 */
export function bowBearing({
  heading,
  courseOverGround,
  speedOverGround,
}: {
  heading?: number;
  courseOverGround?: number;
  speedOverGround?: number;
}): number | undefined {
  if (isFiniteNumber(heading)) return heading;
  if (
    isFiniteNumber(courseOverGround) &&
    isFiniteNumber(speedOverGround) &&
    speedOverGround >= MIN_COG_SPEED
  )
    return courseOverGround;
}

/**
 * Move each sounding from the GNSS antenna to the transducer. The CSB format
 * carries no heading, so nobody downstream can apply the offset; a sounding
 * that can't be corrected here is dropped rather than submitted as corrected.
 */
export function correctForSensorPosition(config: SensorConfig) {
  const { distance, bearing } = getOffsets(config);

  return ({ heading, ...data }: BathymetryData): BathymetryData | null => {
    if (distance === 0) return data;
    if (!isFiniteNumber(heading)) return null;

    // Convert heading from radians to degrees, and adjust for the offset bearing
    const sensorBearing = ((heading * 180) / Math.PI + bearing) % 360;
    const corrected = computeDestinationPoint(data, distance, sensorBearing);

    return {
      ...data,
      ...corrected,
    };
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Get the offsets between the gnss and the sounder */
export function getOffsets({ gnss, sounder }: SensorConfig) {
  // y offset is distance from bow as a positive number
  // e.g. gnss is 13m from bow, sounder is 3m from bow, so offset is 10m
  const dy = gnss.y - sounder.y;

  // x offset is distance from centerline, -ve to port, +ve to starboard
  // e.g. gnss is -1.5m, sounder is -0.5m, so offset is 1m
  const dx = sounder.x - gnss.x;

  return {
    dx,
    dy,
    distance: Math.abs(Math.sqrt(dx * dx + dy * dy)),
    bearing: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360,
  };
}
