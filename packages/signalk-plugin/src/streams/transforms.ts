import { BathymetryData } from "../types.js";
import { computeDestinationPoint } from "geolib";

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
      heading: data.heading
        ? parseFloat(data.heading.toFixed(heading))
        : undefined,
    };
  };
}

export type SensorConfig = {
  gnss: { x: number; y: number };
  sounder: { x: number; y: number };
};

export function correctForSensorPosition(config: SensorConfig) {
  const { distance, bearing } = getOffsets(config);

  return ({ heading, ...data }: BathymetryData) => {
    // No heading data provided, or no position offset, so position can't be corrected
    if (heading === undefined || !Number.isFinite(heading) || distance === 0)
      return data;

    // Convert heading from radians to degrees, and adjust for the offset bearing
    const sensorBearing = ((heading * 180) / Math.PI + bearing) % 360;
    const corrected = computeDestinationPoint(data, distance, sensorBearing);

    return {
      ...data,
      ...corrected,
    };
  };
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
