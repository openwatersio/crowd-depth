import { describe, expect, test } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  RAYMARINE_EPOCH,
  fromRealBathyTrl,
  readTrlRecords,
} from "../../src/streams/realbathy.js";
import { readFile } from "fs/promises";
import { TrlRecord, trl } from "../helper.js";

/** A 5 s batch of 50 records at 10 Hz, each fix repeated `repeat` times. */
function batch(
  seconds: number,
  fixes: Omit<TrlRecord, "seconds">[],
  repeat = 10,
) {
  return fixes.flatMap((fix) =>
    Array.from({ length: repeat }, () => ({ ...fix, seconds })),
  );
}

/** Reads a track recorded by an MFD set to UTC. */
const read = (buffer: Uint8Array) => fromRealBathyTrl(buffer, { utcOffset: 0 });

const at = (seconds: number, milliseconds = 0) =>
  RAYMARINE_EPOCH.add({ seconds, milliseconds });

describe("readTrlRecords", () => {
  test("decodes position, depth and time", () => {
    const records = readTrlRecords(
      trl([
        { lat: -17.76461, lon: 177.18475, depthCm: 661, seconds: 340499483 },
      ]),
    );
    expect(records).toEqual([
      {
        latitude: -17.76461,
        longitude: 177.18475,
        depth: 6.61,
        seconds: 340499483,
      },
    ]);
  });

  test("ignores a trailing partial record", () => {
    const buffer = trl([
      { lat: 1, lon: 2, depthCm: 300, seconds: 10 },
      { lat: 1, lon: 2, depthCm: 300, seconds: 10 },
    ]);
    expect(readTrlRecords(buffer.subarray(0, buffer.length - 1))).toHaveLength(
      1,
    );
  });
});

describe("fromRealBathyTrl", () => {
  test("reads the MFD's local time back to UTC", () => {
    // A run that ended 17:58 Fiji time on an MFD set to UTC-4
    const [sounding] = fromRealBathyTrl(
      trl([
        { lat: -17.7648, lon: 177.18474, depthCm: 1156, seconds: 340509479 },
      ]),
      { utcOffset: -4 },
    );
    expect(sounding.timestamp).toEqual(
      Temporal.Instant.from("2026-10-16T05:57:59Z"),
    );
  });

  test("reads a positive offset back to UTC", () => {
    const [sounding] = fromRealBathyTrl(
      trl([{ lat: 1, lon: 2, depthCm: 300, seconds: 12 * 3600 }]),
      { utcOffset: 12 },
    );
    expect(sounding.timestamp).toEqual(RAYMARINE_EPOCH);
  });

  test("refuses an offset that is not a time zone", () => {
    const buffer = trl([{ lat: 1, lon: 2, depthCm: 300, seconds: 100 }]);
    expect(() => fromRealBathyTrl(buffer, { utcOffset: NaN })).toThrow(
      RangeError,
    );
    expect(() => fromRealBathyTrl(buffer, { utcOffset: 240 })).toThrow(
      RangeError,
    );
  });

  test("keeps one sounding per fix, timed by its first record", () => {
    const soundings = read(
      trl(
        batch(100, [
          { lat: 1, lon: 2, depthCm: 300 },
          { lat: 1.00001, lon: 2, depthCm: 310 },
          { lat: 1.00002, lon: 2, depthCm: 320 },
          { lat: 1.00003, lon: 2, depthCm: 330 },
          { lat: 1.00004, lon: 2, depthCm: 340 },
        ]),
      ),
    );
    expect(soundings.map((s) => [s.depth, s.timestamp])).toEqual([
      [3, at(100)],
      [3.1, at(101)],
      [3.2, at(102)],
      [3.3, at(103)],
      [3.4, at(104)],
    ]);
  });

  test("does not repeat a fix that runs on into the next batch", () => {
    const soundings = read(
      trl([
        ...batch(100, [{ lat: 1, lon: 2, depthCm: 300 }], 50),
        ...batch(105, [{ lat: 1, lon: 2, depthCm: 300 }], 50),
        ...batch(110, [{ lat: 1, lon: 2.0001, depthCm: 350 }], 50),
      ]),
    );
    expect(soundings.map((s) => [s.depth, s.timestamp])).toEqual([
      [3, at(100)],
      [3.5, at(110)],
    ]);
  });

  test("keeps a sounding that reads the same as one before a gap", () => {
    const soundings = read(
      trl([
        { lat: 1, lon: 2, depthCm: 300, seconds: 100 },
        { lat: 1, lon: 2, depthCm: 300, seconds: 3700 },
      ]),
    );
    expect(soundings.map((s) => s.timestamp)).toEqual([at(100), at(3700)]);
  });

  test("spreads a batch of more than 50 records over its 5 s", () => {
    const soundings = read(
      trl(
        Array.from({ length: 100 }, (_, i) => ({
          lat: 1,
          lon: 2,
          depthCm: 300 + i,
          seconds: 100,
        })),
      ),
    );
    expect(soundings.at(-1)?.timestamp).toEqual(at(104, 950));
  });

  test("skips the depth the MFD writes when it has lost the bottom", () => {
    const soundings = read(
      trl([
        { lat: 1, lon: 2, depthCm: 0xffffffff, seconds: 100 },
        { lat: 1, lon: 2.00001, depthCm: 300, seconds: 100 },
      ]),
    );
    expect(soundings.map((s) => s.depth)).toEqual([3]);
  });

  test("skips records with no fix or no depth", () => {
    const soundings = read(
      trl([
        { lat: 0, lon: 0, depthCm: 300, seconds: 100 },
        { lat: 1, lon: 2, depthCm: 0, seconds: 100 },
        { lat: 1, lon: 2.00001, depthCm: 300, seconds: 100 },
      ]),
    );
    expect(soundings).toHaveLength(1);
    expect(soundings[0].longitude).toBe(2.00001);
  });

  test("takes heading from the course while making way", () => {
    // Due north at ~5 m/s (~10 kn): 1e-5° of latitude is ~1.1 m
    const fixes = Array.from({ length: 10 }, (_, i) => ({
      lat: 1 + i * 0.00005,
      lon: 2,
      depthCm: 500,
    }));
    const soundings = read(
      trl([...batch(100, fixes.slice(0, 5)), ...batch(105, fixes.slice(5))]),
    );
    expect(soundings[0].heading).toBeCloseTo(0, 2);
    // The last fixes have nothing far enough ahead to take a course from
    expect(soundings.at(-1)?.heading).toBeUndefined();
  });

  test("leaves heading out when barely moving", () => {
    const fixes = Array.from({ length: 10 }, (_, i) => ({
      lat: 1,
      lon: 2,
      depthCm: 500 + i,
    }));
    const soundings = read(
      trl([...batch(100, fixes.slice(0, 5)), ...batch(105, fixes.slice(5))]),
    );
    expect(soundings.every((s) => s.heading === undefined)).toBe(true);
  });

  test("does not take a course across a gap in recording", () => {
    const soundings = read(
      trl([
        ...batch(100, [{ lat: 1, lon: 2, depthCm: 500 }], 50),
        ...batch(1000, [{ lat: 1.01, lon: 2, depthCm: 500 }], 50),
      ]),
    );
    expect(soundings[0].heading).toBeUndefined();
  });
});

describe("a recording from an Axiom on LightHouse 4.11", () => {
  // The first 300 records of a RealVision 3D track off Malolo Lailai, Fiji
  const fixture = new URL("../fixtures/realbathy-excerpt.trl", import.meta.url);

  test("reads 30 s of soundings at the recorded place and time", async () => {
    const soundings = fromRealBathyTrl(await readFile(fixture), {
      utcOffset: -4,
    });
    expect(soundings).toHaveLength(58);
    expect(soundings[0]).toMatchObject({
      latitude: -17.76461,
      longitude: 177.18475,
      depth: 6.61,
      timestamp: Temporal.Instant.from("2026-10-16T03:11:23Z"),
    });
    expect(soundings.at(-1)?.timestamp).toEqual(
      Temporal.Instant.from("2026-10-16T03:11:52.9Z"),
    );
    for (const { depth } of soundings) {
      expect(depth).toBeGreaterThan(5);
      expect(depth).toBeLessThan(12.5);
    }
  });
});
