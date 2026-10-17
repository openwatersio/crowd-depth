import { expect, test } from "vitest";
import {
  ASSET_BASE,
  PLUGIN_ID,
  buildManifest,
} from "../../src/plotterext/manifest.js";

test("declares an image overlay drawn by a declared background runtime", () => {
  const m = buildManifest("9.9.9");
  expect(m.apiVersion).toBe("1");
  expect(m.version).toBe("9.9.9");
  expect(m.requires).toEqual(
    expect.arrayContaining([
      "background.iframe",
      "overlays.image",
      "signalk.stream",
    ]),
  );

  const background = m.background as { id: string; url: string }[];
  expect(background).toEqual([
    { id: "renderer", type: "iframe", url: `${ASSET_BASE}/renderer.html` },
  ]);

  const overlays = m.overlays as {
    id: string;
    type: string;
    runtime: string;
    band: string;
  }[];
  expect(overlays).toEqual([
    expect.objectContaining({
      id: "depth",
      type: "image",
      runtime: "renderer",
      band: "aboveCharts",
    }),
  ]);
  // The overlay's runtime must name a runtime in this manifest, or the host
  // omits the overlay.
  expect(background.some((b) => b.id === overlays[0].runtime)).toBe(true);
});

test("the toolbar button opens a panel declared here", () => {
  const m = buildManifest();
  const buttons = m.buttons as {
    action: { type: string; panel: string };
  }[];
  expect(buttons[0].action.type).toBe("togglePanel");
  const panels = m.panels as { id: string; url: string }[];
  expect(panels.some((p) => p.id === buttons[0].action.panel)).toBe(true);
  expect(panels[0].url.startsWith(ASSET_BASE)).toBe(true);
});

test("the overlay points at a declared settings panel and a pixel density", () => {
  const m = buildManifest();
  const overlays = m.overlays as {
    configPanel?: string;
    preferredPixelRatio?: number;
  }[];
  const panels = m.panels as { id: string }[];
  // A configPanel naming a panel here gives the layer a "Layer settings"
  // button on its Chart-list row; one the host can't resolve is ignored.
  expect(overlays[0].configPanel).toBe("my-soundings-settings");
  expect(panels.some((p) => p.id === overlays[0].configPanel)).toBe(true);
  expect(overlays[0].preferredPixelRatio).toBeGreaterThan(0);
});

test("PLUGIN_ID names the extension resource key", () => {
  expect(PLUGIN_ID).toBe("crowd-depth");
});
