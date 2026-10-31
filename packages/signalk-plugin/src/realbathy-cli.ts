import { readFile } from "fs/promises";
import { Readable, Writable } from "stream";
import { pipeline } from "stream/promises";
import { fromRealBathyTrl, RealBathyOptions } from "./streams/realbathy.js";
import { toXyz } from "./streams/xyz.js";

/**
 * Converts a RealBathy `.trl` track to XYZ. Positions stay where the MFD's
 * GNSS put them: the sensor offsets of the vessel that made the recording are
 * not this server's. The heading is left out for the same reason, so that
 * xyz-to-geojson, which applies this server's offsets, drops the soundings
 * rather than moving them by another vessel's offsets.
 */
export async function realbathyToXyz(
  file: string,
  options: RealBathyOptions,
  output: Writable = process.stdout,
) {
  const soundings = fromRealBathyTrl(await readFile(file), options);
  return pipeline(
    Readable.from(soundings),
    toXyz({ includeHeading: false }),
    output,
  );
}
