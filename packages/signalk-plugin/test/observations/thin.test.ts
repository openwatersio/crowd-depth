import { expect, it } from "vitest";
import { thinStationary } from "../../src/observations/thin.js";
import type { Observation } from "../../src/observations/store.js";
import { readFileSync } from "node:fs";
const options = {
  horizontalToleranceM: 1,
  depthToleranceM: 0.02,
  maxGapSeconds: 180,
  stationarySpeedMps: 0.2,
};
const start = Date.parse("2026-11-24T00:00:00Z");
const point = (
  seconds: number,
  overrides: Partial<Observation> = {},
): Observation => ({
  timestamp: new Date(start + seconds * 1000).toISOString(),
  longitude: -80,
  latitude: 26,
  depth: 3,
  speedOverGround: 0.01,
  depthSource: "sounder",
  positionSource: "gps",
  ...overrides,
});
it("matches independent GEOS Douglas-Peucker results for horizontal geometry", () => {
  const reference = JSON.parse(
    readFileSync(
      new URL("./fixtures/geos-thinning.json", import.meta.url),
      "utf8",
    ),
  ) as {
    count: number;
    fixtures: { toleranceM: number; kept: number[] }[];
  };
  const points = Array.from({ length: reference.count }, (_, i) =>
    point(i / 5, {
      longitude: i / 10 / 111320,
      latitude: (2 * Math.sin(i * 0.073) + 0.4 * Math.cos(i * 0.157)) / 111320,
    }),
  );
  for (const fixture of reference.fixtures)
    expect(
      thinStationary(points, {
        ...options,
        horizontalToleranceM: fixture.toleranceM,
        maxGapSeconds: 360,
      }),
    ).toEqual(fixture.kept);
});
it("retains at least one observation per configured interval at rest", () => {
  const points = Array.from({ length: 9001 }, (_, i) => point(i / 5));
  for (const maxGapSeconds of [60, 180, 360]) {
    const retained = thinStationary(points, { ...options, maxGapSeconds });
    expect(retained[0]).toBe(0);
    expect(retained.at(-1)).toBe(9000);
    expect(retained.length).toBeLessThan(33);
    for (let i = 1; i < retained.length; i++)
      expect((retained[i] - retained[i - 1]) / 5).toBeLessThanOrEqual(
        maxGapSeconds,
      );
  }
});
it("retains original-time tide excursions within the depth error tolerance", () => {
  const points = Array.from({ length: 9001 }, (_, i) =>
    point(i / 5, { depth: 4 + Math.sin(i / 300) * 0.6 }),
  );
  const retained = thinStationary(points, options);
  expect(retained.length).toBeLessThan(points.length / 10);
  for (let k = 1; k < retained.length; k++) {
    const a = retained[k - 1],
      b = retained[k];
    for (let i = a + 1; i < b; i++) {
      const estimate =
        points[a].depth +
        ((points[b].depth - points[a].depth) * (i - a)) / (b - a);
      expect(Math.abs(points[i].depth - estimate)).toBeLessThanOrEqual(
        options.depthToleranceM + 1e-12,
      );
    }
  }
});
it("preserves anchor-swing shape and an isolated depth change", () => {
  const points = Array.from({ length: 301 }, (_, i) =>
    point(i, {
      longitude: -80 + Math.sin(i / 30) * 0.0002,
      latitude: 26 + Math.cos(i / 30) * 0.0002,
      depth: i === 130 ? 1 : 3,
    }),
  );
  const retained = thinStationary(points, options);
  expect(retained).toContain(130);
  expect(retained.length).toBeGreaterThan(10);
  expect(retained.length).toBeLessThan(100);
});
it("retains moving, unknown-speed, duplicate-time and transition observations", () => {
  const points = [
    point(0),
    point(1, { speedOverGround: undefined }),
    point(2),
    point(3, { speedOverGround: 2 }),
    point(4),
    point(5, { depthSource: "other" }),
    point(6, { depthSource: "other", gnss: { integrity: "unsafe" } }),
    point(6, { depthSource: "other", gnss: { integrity: "unsafe" } }),
    point(7),
  ];
  expect(thinStationary(points, options)).toEqual(points.map((_, i) => i));
});
it("keeps both sides of missing intervals without inventing samples", () => {
  const points = [
    point(0),
    point(1),
    point(2),
    point(1000),
    point(1001),
    point(1002),
  ];
  expect(thinStationary(points, options)).toEqual([0, 2, 3, 5]);
});
it("uses original times for depth, independent of distance along the track", () => {
  const points = [
    point(0, { depth: 0 }),
    point(1, { depth: 1 }),
    point(100, { depth: 100 }),
  ];
  expect(thinStationary(points, options)).toEqual([0, 2]);
  points[1].depth = 50;
  expect(thinStationary(points, options)).toEqual([0, 1, 2]);
});
it("does not create a false excursion at the date line", () => {
  expect(
    thinStationary(
      [
        point(0, { longitude: 179.9999 }),
        point(1, { longitude: 180 }),
        point(2, { longitude: -179.9999 }),
      ],
      options,
    ),
  ).toEqual([0, 2]);
});

it("preserves arrivals intact across a backwards clock adjustment", () => {
  expect(
    thinStationary([point(0), point(2), point(1), point(3)], options),
  ).toEqual([0, 1, 2, 3]);
});
