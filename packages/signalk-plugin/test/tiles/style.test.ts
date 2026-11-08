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

test("the ribbon is drawn below the depth areas, and the soundings' circles only at points", () => {
  const style = buildStyle({ tiles: "t/{z}/{x}/{y}.pbf", safetyDepth: 3 });
  const ids = style.layers.map((l) => l.id);
  // Over water sounded before, the stored area shows, as shoal as it is.
  expect(ids.indexOf("ribbon")).toBeLessThan(ids.indexOf("depare"));
  const layer = (id: string) =>
    style.layers.find((l) => l.id === id) as { filter?: unknown };
  expect(layer("provisional").filter).toEqual([
    "==",
    ["geometry-type"],
    "Point",
  ]);
  expect(layer("ribbon").filter).toEqual([
    "==",
    ["geometry-type"],
    "LineString",
  ]);
});
