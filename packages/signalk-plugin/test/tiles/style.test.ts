import { expect, test } from "vitest";
import { buildStyle } from "../../src/tiles/style.js";

test("contour labels sit above deeper soundings and below shoal ones", () => {
  const ids = buildStyle({ tiles: "t", safetyDepth: 2 }).layers.map(
    (l) => l.id,
  );
  expect(ids.indexOf("depcnt-label-minor")).toBeGreaterThan(
    ids.indexOf("soundg"),
  );
  expect(ids.indexOf("depcnt-label")).toBeGreaterThan(
    ids.indexOf("depcnt-label-minor"),
  );
  expect(ids.indexOf("soundg-shoal")).toBeGreaterThan(
    ids.indexOf("depcnt-label"),
  );
  const minor = buildStyle({ tiles: "t", safetyDepth: 2 }).layers.find(
    (l) => l.id === "depcnt-label-minor",
  ) as { minzoom?: number };
  expect(minor.minzoom).toBe(15);
});

test("soundings get extra padding only from zoom 15, where tiles are denser", () => {
  const soundg = buildStyle({ tiles: "t", safetyDepth: 2 }).layers.find(
    (l) => l.id === "soundg",
  ) as { layout: Record<string, unknown> };
  // The default 2 px below zoom 15, where tiles hold 8 soundings a side.
  expect(soundg.layout["text-padding"]).toEqual([
    "step",
    ["zoom"],
    2,
    15,
    8,
    16,
    5,
    17,
    2,
  ]);
});
