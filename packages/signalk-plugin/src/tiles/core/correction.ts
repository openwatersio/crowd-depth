// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
/**
 * GNSS antenna → depth transducer correction for the chart client's live
 * soundings, the browser counterpart of `correctForSensorPosition` in
 * `streams/transforms.ts`. The plugin serves the body-frame offset in its tile
 * meta, so both sides place a sounding at the same spot.
 */

/** Body-frame offset of the transducer from the position reference, in metres:
 * `forward` toward the bow, `starboard` to starboard. */
export interface TransducerOffset {
  forward: number;
  starboard: number;
}

/** A lon/lat position. */
export interface LonLat {
  lon: number;
  lat: number;
}

const EARTH_RADIUS_M = 6378137;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Slowest speed over ground, in m/s (~1 kn), at which course over ground stands
 * in for a missing heading. Above it, leeway and current rarely put COG more
 * than ~10° off heading, which moves a 6 m offset by ~1 m, under GNSS error.
 */
export const MIN_COG_SPEED = 0.5144;

/**
 * Shift `position` from the reference point to the transducer, rotating the
 * body-frame `offset` by `heading` (true, radians, clockwise from north).
 * Returns `position` unchanged when there is no offset, and undefined when
 * there is an offset but no heading, so the sounding is dropped rather than
 * placed at the antenna, matching what the plugin records.
 */
export function correctToTransducer(
  position: LonLat,
  heading: number | undefined,
  offset: TransducerOffset,
): LonLat | undefined {
  if (!offset.forward && !offset.starboard) return position;
  if (heading === undefined || !Number.isFinite(heading)) return undefined;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  // +x body (toward bow) points along the heading; +y body (starboard) is 90°
  // clockwise from it.
  const north = offset.forward * cos - offset.starboard * sin;
  const east = offset.forward * sin + offset.starboard * cos;
  const lat = position.lat + (north / EARTH_RADIUS_M) * RAD_TO_DEG;
  const lon =
    position.lon +
    (east / (EARTH_RADIUS_M * Math.cos(position.lat * DEG_TO_RAD))) *
      RAD_TO_DEG;
  // wrap into [-180, 180] so a shift near the antimeridian stays in range
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lon: wrapped, lat };
}
