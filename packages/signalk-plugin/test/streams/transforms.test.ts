import { describe, expect, test } from "vitest";
import {
  correctForSensorPosition,
  getOffsets,
} from "../../src/streams/transforms.js";
import { getDistance } from "geolib";
import { Temporal } from "@js-temporal/polyfill";

describe("getOffsets", () => {
  test("same position", () => {
    const sounder = { x: 0, y: 0 };
    const gnss = { x: 0, y: 0 };

    expect(getOffsets({ sounder, gnss })).toEqual({
      distance: 0,
      bearing: 0,
      dx: 0,
      dy: 0,
    });
  });

  test("sounder forward", () => {
    const gnss = { x: 0, y: 2 };
    const sounder = { x: 0, y: 1 };
    expect(getOffsets({ gnss, sounder })).toEqual({
      distance: 1,
      bearing: 0,
      dx: 0,
      dy: 1,
    });
  });

  test("sounder aft", () => {
    const gnss = { x: 0, y: 1 };
    const sounder = { x: 0, y: 2 };
    expect(getOffsets({ gnss, sounder })).toEqual({
      distance: 1,
      bearing: 180,
      dx: 0,
      dy: -1,
    });
  });

  test("sounder aft and port of gnss", () => {
    const gnss = { x: 0.5, y: 1 };
    const sounder = { x: -0.5, y: 2 };

    expect(getOffsets({ gnss, sounder })).toEqual({
      distance: 1.4142135623730951,
      bearing: 225,
      dx: -1,
      dy: -1,
    });
  });

  test("sounder forward and starboard of gnss", () => {
    const gnss = { x: -1.5, y: 13 };
    const sounder = { x: -0.5, y: 3 };

    const { distance, bearing, dx, dy } = getOffsets({ gnss, sounder });
    expect(distance).toBeCloseTo(10.05, 2);
    expect(bearing).toBeCloseTo(5.71, 2);
    expect(dx).toEqual(1);
    expect(dy).toEqual(10);
  });
});

describe("correctForSensorPosition", () => {
  const data = {
    latitude: 1,
    longitude: 1,
    heading: 0,
    depth: 1,
    timestamp: Temporal.Now.instant(),
  };

  test("no offset", () => {
    const corrector = correctForSensorPosition({
      gnss: { x: 0, y: 0 },
      sounder: { x: 0, y: 0 },
    });

    expect(corrector(data)).toEqual({
      latitude: data.latitude,
      longitude: data.longitude,
      depth: data.depth,
      timestamp: data.timestamp,
    });
  });

  test("sounder forward", () => {
    const corrector = correctForSensorPosition({
      gnss: { x: 0, y: 10 },
      sounder: { x: 0, y: 0 },
    });

    const corrected = corrector(data);

    expect(getDistance(data, corrected)).toBeCloseTo(10, 2);
    expect(corrected.latitude).toBeCloseTo(1.00009, 5);
    expect(corrected.longitude).toEqual(data.longitude);
    expect(corrected.depth).toEqual(data.depth);
    expect(corrected.timestamp).toEqual(data.timestamp);
    expect("heading" in corrected).toBe(false);
  });
});
