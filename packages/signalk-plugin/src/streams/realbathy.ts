import { Temporal } from "@js-temporal/polyfill";
import { getDistance, getGreatCircleBearing } from "geolib";
import { BathymetryData } from "../types.js";
import { bowBearing } from "./transforms.js";

/**
 * Reader for the sounding track Raymarine LightHouse 4 MFDs record for
 * RealBathy: `realbathy/<id>.trl` on the chart card. The format is
 * undocumented; the layout below was worked out from an Axiom recording made
 * with a RealVision 3D transducer on LightHouse 4.11. The `<x>-<y>-<z>.trk`
 * files beside it hold the same depths binned into ~4 m cells, which is
 * processed data, so only the track is read.
 *
 * Little-endian: an 8-byte header, then 24-byte records of
 *   int32 latitude (1e-5°), int32 longitude (1e-5°), uint32 depth (cm),
 *   uint16 0xFFFF, uint16 0, uint32 time (s since RAYMARINE_EPOCH), uint32 0.
 *
 * The time is the MFD's local time: its "Time offset from UTC" setting is
 * applied before writing and is not recorded, so the reader has to be told it.
 */
export const TRL_HEADER_SIZE = 8;
export const TRL_RECORD_SIZE = 24;

/** Zero point of the record time, read as the MFD's local time. */
export const RAYMARINE_EPOCH = Temporal.Instant.from("2016-01-01T00:00:00Z");

export type RealBathyOptions = {
  /** The MFD's "Time offset from UTC" when it recorded, in hours (e.g. -4). */
  utcOffset: number;
};

/**
 * The MFD writes records at 10 Hz but stamps them in 5 s batches and repeats
 * each fix until the next one arrives.
 */
const BATCH_MS = 5000;
const RECORDS_PER_BATCH = 50;

/**
 * Deeper than any ocean: the uint32 maximum the MFD writes when it has lost
 * the bottom decodes to 42,949,672.95 m.
 */
const MAX_DEPTH = 11000;

type TrlRecord = {
  latitude: number;
  longitude: number;
  depth: number;
  seconds: number;
};

export function readTrlRecords(buffer: Uint8Array): TrlRecord[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
  const records: TrlRecord[] = [];

  for (
    let offset = TRL_HEADER_SIZE;
    offset + TRL_RECORD_SIZE <= buffer.length;
    offset += TRL_RECORD_SIZE
  ) {
    records.push({
      latitude: view.getInt32(offset, true) / 1e5,
      longitude: view.getInt32(offset + 4, true) / 1e5,
      depth: view.getUint32(offset + 8, true) / 100,
      seconds: view.getUint32(offset + 16, true),
    });
  }

  return records;
}

/**
 * Soundings from a `.trl` buffer: one per fix, timed by its first record within
 * the batch, with a heading taken from the course over the next few seconds
 * while the vessel is making way (see bowBearing), since the file records none.
 */
export function fromRealBathyTrl(
  buffer: Uint8Array,
  { utcOffset }: RealBathyOptions,
): BathymetryData[] {
  if (!Number.isFinite(utcOffset) || Math.abs(utcOffset) > 14) {
    throw new RangeError(
      `utcOffset must be the MFD's offset from UTC in hours, not ${utcOffset}`,
    );
  }
  const epoch = RAYMARINE_EPOCH.subtract({
    milliseconds: Math.round(utcOffset * 3600 * 1000),
  });
  const records = readTrlRecords(buffer);
  const soundings: BathymetryData[] = [];

  let batchStart = 0;
  while (batchStart < records.length) {
    const { seconds } = records[batchStart];
    let batchEnd = batchStart;
    while (batchEnd < records.length && records[batchEnd].seconds === seconds) {
      batchEnd++;
    }

    const recordMs =
      BATCH_MS / Math.max(batchEnd - batchStart, RECORDS_PER_BATCH);
    for (let i = batchStart; i < batchEnd; i++) {
      const record = records[i];
      const previous = records[i - 1];
      if (previous && isRepeat(previous, record)) continue;
      if (!isValid(record)) continue;

      const offsetMs = Math.round((i - batchStart) * recordMs);
      soundings.push({
        latitude: record.latitude,
        longitude: record.longitude,
        depth: record.depth,
        timestamp: epoch.add({
          seconds: record.seconds,
          milliseconds: offsetMs,
        }),
      });
    }

    batchStart = batchEnd;
  }

  return withHeadings(soundings);
}

/**
 * A fix repeated by the MFD rather than a new sounding that happens to read
 * the same: the repeat sits in the same batch or runs on into the next one.
 */
function isRepeat(a: TrlRecord, b: TrlRecord) {
  return (
    b.seconds - a.seconds <= BATCH_MS / 1000 &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.depth === b.depth
  );
}

function isValid({ latitude, longitude, depth }: TrlRecord) {
  return (
    depth > 0 &&
    depth < MAX_DEPTH &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

/**
 * Positions are stored to 1e-5° (~1 m), so the course between fixes a second
 * apart can be off by tens of degrees; it is taken over a few seconds instead.
 */
const COURSE_BASELINE_S = 5;
const MAX_COURSE_BASELINE_S = 15;

function withHeadings(soundings: BathymetryData[]): BathymetryData[] {
  let j = 0;
  return soundings.map((sounding, i) => {
    if (j <= i) j = i + 1;
    while (
      j < soundings.length &&
      secondsBetween(sounding, soundings[j]) < COURSE_BASELINE_S
    )
      j++;

    const next = soundings[j];
    if (!next) return sounding;
    const seconds = secondsBetween(sounding, next);
    if (seconds > MAX_COURSE_BASELINE_S) return sounding;

    const heading = bowBearing({
      courseOverGround: (getGreatCircleBearing(sounding, next) * Math.PI) / 180,
      speedOverGround: getDistance(sounding, next, 0.01) / seconds,
    });
    return heading === undefined ? sounding : { ...sounding, heading };
  });
}

function secondsBetween(a: BathymetryData, b: BathymetryData) {
  return b.timestamp.since(a.timestamp).total("milliseconds") / 1000;
}
