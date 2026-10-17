import { expect, test } from "vitest";
import { correctToTransducer } from "../../../src/tiles/core/correction.js";

// ~10 m in degrees at the equator.
const TEN_M_DEG = (10 / 6378137) * (180 / Math.PI);

test("leaves the position unchanged without an offset", () => {
  const p = { lon: 1, lat: 2 };
  expect(correctToTransducer(p, undefined, { forward: 0, starboard: 0 })).toBe(
    p,
  );
  expect(correctToTransducer(p, 0, { forward: 0, starboard: 0 })).toBe(p);
});

test("drops a sounding with an offset but no heading", () => {
  // The plugin drops these rather than recording them at the antenna, so the
  // client must too, or its live soundings won't match the served tiles.
  expect(
    correctToTransducer({ lon: 1, lat: 2 }, undefined, {
      forward: 10,
      starboard: 5,
    }),
  ).toBeUndefined();
});

test("shifts forward along the heading", () => {
  // heading 0 = north: a forward offset moves north (lat up)
  const north = correctToTransducer({ lon: 0, lat: 0 }, 0, {
    forward: 10,
    starboard: 0,
  })!;
  expect(north.lat).toBeCloseTo(TEN_M_DEG, 10);
  expect(north.lon).toBeCloseTo(0, 10);

  // heading east (π/2): a forward offset moves east (lon up)
  const east = correctToTransducer({ lon: 0, lat: 0 }, Math.PI / 2, {
    forward: 10,
    starboard: 0,
  })!;
  expect(east.lon).toBeCloseTo(TEN_M_DEG, 10);
  expect(east.lat).toBeCloseTo(0, 10);
});

test("shifts starboard to the right of the heading", () => {
  // heading north: starboard is east
  const p = correctToTransducer({ lon: 0, lat: 0 }, 0, {
    forward: 0,
    starboard: 10,
  })!;
  expect(p.lon).toBeCloseTo(TEN_M_DEG, 10);
  expect(p.lat).toBeCloseTo(0, 10);
});
