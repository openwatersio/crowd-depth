import { expect, test } from "vitest";
import definitions from "../../grid/src/grid/definitions.json" with { type: "json" };
import vectors from "../../grid/tests/qc_vectors.json" with { type: "json" };
import { trackQC, type Flag } from "../src/qc.js";

const us = (seconds: number) => Math.round(seconds * 1e6);
const sorted = (flags: Flag[]) =>
  flags
    .map((f) => f.join())
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

test.each(vectors.cases)("$name", ({ soundings, arrival, flags }) => {
  const points = soundings.map(([time, lon, lat, depth]) => ({
    time: us(time),
    lon,
    lat,
    depth,
  }));
  expect(sorted(trackQC(points, us(arrival), definitions.qc))).toEqual(
    sorted(flags as Flag[]),
  );
});

test("the vectors exercise every check", () => {
  const fired = new Set(
    vectors.cases.flatMap((c) => c.flags.map((f) => `${f[1]} ${f[2]}`)),
  );
  expect([...fired].sort()).toEqual([
    "noisy track_noise",
    "reject flatline",
    "reject jump",
    "reject sentinel",
    "reject spike",
    "reject steep",
    "reject time",
    "review very_shallow",
    "unconfirmed flatline",
    "unconfirmed spike",
    "unconfirmed track_noise",
  ]);
});

test("a day of a moored boat holding one depth is one long run, not stuck", () => {
  const t0 = Date.UTC(2026, 9, 13) * 1000;
  const points = Array.from({ length: 200_000 }, (_, i) => ({
    time: t0 + i * 500_000,
    lon: -78 + (i % 2) * 1e-5,
    lat: 33,
    depth: 1.8,
  }));
  expect(trackQC(points, points.at(-1)!.time, definitions.qc)).toEqual([]);
});
