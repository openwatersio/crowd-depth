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

test("the soundings' circles are drawn only at points", () => {
  const style = buildStyle({ tiles: "t/{z}/{x}/{y}.pbf", safetyDepth: 3 });
  const layer = (id: string) =>
    style.layers.find((l) => l.id === id) as { filter?: unknown };
  expect(layer("provisional").filter).toEqual([
    "==",
    ["geometry-type"],
    "Point",
  ]);
});

test("the preview lies under the tiles, its contours with theirs", () => {
  const ids = (contours: boolean) =>
    buildStyle({
      tiles: "t",
      safetyDepth: 2,
      own: { accent: "#000000", shoal: "#000000", tint: "normal", contours },
    }).layers.map((l) => l.id);
  const on = ids(true);
  // Over water sounded before, the stored area shows, as shoal as it is.
  expect(on.indexOf("preview-depare")).toBeLessThan(on.indexOf("depare"));
  expect(on.indexOf("depcnt-preview")).toBeGreaterThan(
    on.indexOf("preview-depare"),
  );
  expect(on.indexOf("depcnt-preview")).toBeLessThan(on.indexOf("depare"));
  expect(ids(false)).toContain("preview-depare");
  expect(ids(false)).not.toContain("depcnt-preview");
});
