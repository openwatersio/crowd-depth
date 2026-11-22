import { expect, test } from "vitest";
import {
  halfLifeDays,
  mergeMoments,
  type Moments,
} from "../../src/tiles/decay.js";
const point = (mean: number, day: number): Moments => ({
  time: day * 86400000,
  weight: 1,
  weight2: 1,
  mean,
  m2: 0,
  tide: 0.2,
  passes: 1,
  first: day,
  last: day,
});
test("timestamp weights have the configured half-life in any acquisition order", () => {
  const points = [point(4, 0), point(10, 365), point(7, 730)];
  const expected = (4 * 0.25 + 10 * 0.5 + 7) / 1.75;
  for (const order of [
    points,
    [...points].reverse(),
    [points[1], points[0], points[2]],
  ]) {
    const m = order.reduce<Moments | undefined>(
      (a, b) => mergeMoments(a, b, 365),
      undefined,
    )!;
    expect(m.mean).toBeCloseTo(expected, 12);
    expect(m.weight).toBeCloseTo(1.75, 12);
    expect(m.passes).toBe(3);
    const variance = points.reduce(
      (n, p) =>
        n +
        2 ** ((p.time - m.time) / (365 * 86400000)) * (p.mean - expected) ** 2,
      0,
    );
    expect(m.m2).toBeCloseTo(variance, 12);
  }
});
test("merging chunks agrees with individual observations and extreme ages stay finite", () => {
  const a = mergeMoments(point(10000, 0), point(10000.001, 1), 365);
  const b = mergeMoments(point(9999.999, 2), point(10000, 3), 365);
  const merged = mergeMoments(a, b, 365);
  const singles = [0, 1, 2, 3]
    .map((day) => point([10000, 10000.001, 9999.999, 10000][day], day))
    .reduce<Moments | undefined>((a, b) => mergeMoments(a, b, 365), undefined)!;
  expect(merged.mean).toBeCloseTo(singles.mean, 10);
  expect(merged.m2).toBeCloseTo(singles.m2, 10);
  const old = mergeMoments(point(100, 0), point(2, 10000), 1);
  expect(old.mean).toBe(2);
  expect(old.m2).toBe(0);
  expect(old.passes).toBe(2);
});
test("invalid hand-edited half-lives use the conservative default", () => {
  for (const value of [0, -1, NaN, Infinity, "30", null, 36501])
    expect(halfLifeDays(value)).toBe(365);
  expect(halfLifeDays(730)).toBe(730);
});
