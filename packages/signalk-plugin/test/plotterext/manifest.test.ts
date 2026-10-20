import { expect, test } from "vitest";
import {
  ASSET_BASE,
  OVERLAY_ID,
  PLUGIN_ID,
  buildManifest,
} from "../../src/plotterext/manifest.js";
import { STYLE_PATH } from "../../src/tiles/api.js";

test("declares a data overlay drawn from the plugin's style", () => {
  const m = buildManifest("1.2.3");
  expect(m.version).toBe("1.2.3");
  expect(m.requires).toEqual(["overlays.data"]);
  expect(m.overlays).toEqual([
    expect.objectContaining({
      id: OVERLAY_ID,
      type: "data",
      band: "aboveCharts",
      style: STYLE_PATH,
    }),
  ]);
});

test("a background runtime keeps it current where the host has one", () => {
  const m = buildManifest("1.2.3");
  // Optional: without it the layer still draws, as of when it was shown.
  expect(m.optional).toContain("background.iframe");
  expect(m.background).toEqual([
    expect.objectContaining({
      type: "iframe",
      url: `${ASSET_BASE}/runtime.html`,
    }),
  ]);
});

test("PLUGIN_ID names the extension resource key", () => {
  expect(PLUGIN_ID).toBe("crowd-depth");
  expect(ASSET_BASE).toBe("/plotterext/crowd-depth");
});
