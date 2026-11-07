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
