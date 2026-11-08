import { expect, test, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { createDB } from "../../src/storage.js";
import {
  LIVE_PATH,
  STYLE_PATH,
  TILES_PATH,
  createCellStore,
  createTileService,
  registerLayerRoutes,
} from "../../src/tiles/index.js";
import { parseView, refreshMs, thin } from "../../src/tiles/api.js";
import { DEFAULT_OWN_STYLE } from "../../src/tiles/style.js";
import type { Layer } from "../../src/tiles/api.js";
import type { GeoFeature } from "../../src/tiles/preview.js";
import { cellAt, cellCenter, tileFraction } from "../../src/tiles/geometry.js";

interface Res {
  code: number;
  body?: unknown;
  set(key: string, value: string): Res;
  status(code: number): Res;
  json(body: unknown): Res;
  end(): Res;
  send(body: unknown): Res;
}

const response = (): Res => {
  const res: Res = {
    code: 200,
    set: () => res,
    status: (code) => ((res.code = code), res),
    json: (body) => ((res.body = body), res),
    end: () => res,
    send: (body) => ((res.body = body), res),
  };
  return res;
};

type Req = { params?: Record<string, string>; query?: Record<string, string> };

function serve(own = DEFAULT_OWN_STYLE, preview?: Layer["preview"]) {
  const handlers = new Map<string, (req: Req, res: Res) => unknown>();
  const app = {
    get: (path: string, handler: (req: Req, res: Res) => void) =>
      handlers.set(path, handler),
  } as unknown as ServerAPI;
  const store = createCellStore(createDB(":memory:"));
  const tiles = createTileService(store);
  registerLayerRoutes(app, () => ({
    tiles,
    provisional: () => [{ time: 1, lon: -76.2, lat: 36.98, depth: 4.37 }],
    stored: () => [],
    safetyDepth: 3,
    own,
    preview,
  }));
  const get = async (path: string, req: Req = {}) => {
    const res = response();
    await handlers.get(path)!(req, res);
    return res;
  };
  return { store, tiles, get };
}

test("serves the style, with the tiles under the extension's route", async () => {
  const { get } = serve();
  const style = (await get(STYLE_PATH)).body as {
    sources: { cells: { tiles: string[] } };
    state: Record<string, { default: unknown }>;
    layers: { id: string }[];
  };
  expect(style.sources.cells.tiles).toEqual([`${TILES_PATH}/{z}/{x}/{y}.pbf`]);
  expect(style.state.safetyDepth.default).toBe(3);
  expect(style.state.ownColor.default).toBe("#7b2cbf");
  expect(style.state.ownShoal.default).toBe("#3c096c");
  expect(style.state.ownTint.default).toBe(1);
  expect(style.layers.map((l) => l.id)).toContain("depcnt");
  // The layers draw with the state, not colours of their own.
  const layers = JSON.stringify(style.layers);
  for (const key of ["ownColor", "ownShoal", "ownTint"]) {
    expect(layers).toContain(`["global-state","${key}"]`);
  }
});

// The stacks openwatersio/tile-fonts publishes; a symbol layer without a text-font asks
// for MapLibre's default "Open Sans Regular", which the server doesn't have.
test("sets every label in a font the glyph server publishes", async () => {
  const { get } = serve();
  const style = (await get(STYLE_PATH)).body as {
    glyphs: string;
    layers: { type: string; layout?: { "text-font"?: string[] } }[];
  };
  expect(style.glyphs).toBe(
    "https://tiles.openwaters.io/fonts/{fontstack}/{range}.pbf",
  );
  const symbols = style.layers.filter((l) => l.type === "symbol");
  expect(symbols.length).toBeGreaterThan(0);
  for (const layer of symbols) {
    expect(layer.layout?.["text-font"]).toBeDefined();
    for (const font of layer.layout!["text-font"]!) {
      expect(["Noto Sans Medium", "Noto Sans Medium Italic"]).toContain(font);
    }
  }
});

test("draws the boat's own data in the colour, tint and contours set", async () => {
  const { get } = serve({
    accent: "#00a0a0",
    shoal: "#004040",
    tint: "strong",
    contours: false,
  });
  const style = (await get(STYLE_PATH)).body as {
    state: Record<string, { default: unknown }>;
    layers: { id: string }[];
  };
  expect(style.state.ownColor.default).toBe("#00a0a0");
  expect(style.state.ownShoal.default).toBe("#004040");
  expect(style.state.ownTint.default).toBe(2);
  expect(style.layers.map((l) => l.id)).not.toContain("depcnt");
  expect(style.layers.map((l) => l.id)).not.toContain("depcnt-label");
  expect(style.layers.map((l) => l.id)).not.toContain("depcnt-label-minor");
});

test("serves a tile as MVT bytes, and nothing where there are no cells", async () => {
  const { store, get } = serve();
  const { py, px } = cellAt(-76.2, 36.98);
  store.addPasses([{ py, px, depth: 6, day: 20000 }]);
  const f = tileFraction(-76.2, 36.98, 14);
  const params = { z: "14", x: `${Math.floor(f.x)}`, y: `${Math.floor(f.y)}` };
  const tile = await get(`${TILES_PATH}/:z/:x/:y.pbf`, { params });
  expect(Buffer.isBuffer(tile.body)).toBe(true);
  const decoded = new VectorTile(new PbfReader(tile.body as Buffer));
  expect(Object.keys(decoded.layers).sort()).toEqual([
    "DEPARE",
    "M_QUAL",
    "SOUNDG",
  ]);

  const empty = await get(`${TILES_PATH}/:z/:x/:y.pbf`, {
    params: { ...params, x: "0" },
  });
  expect(empty.code).toBe(204);
  const bad = await get(`${TILES_PATH}/:z/:x/:y.pbf`, {
    params: { ...params, z: "20" },
  });
  expect(bad.code).toBe(400);
});

test("the live feed names the tiles a change touched, and the provisional soundings", async () => {
  const { tiles, get } = serve();
  const live = async (since: number) =>
    (await get(LIVE_PATH, { query: { since: `${since}` } })).body as {
      rev: number;
      all?: boolean;
      tiles: number[][];
      provisional: { features: { properties: { depth_m: number } }[] };
    };
  const first = await live(-1);
  expect(first.all).toBe(true);
  expect(first.provisional.features[0].properties.depth_m).toBe(4.3);

  const { py, px } = cellAt(-76.2, 36.98);
  tiles.changed([cellCenter(py, px)]);
  const next = await live(first.rev);
  const f = tileFraction(-76.2, 36.98, 14);
  expect(next.tiles).toContainEqual([14, Math.floor(f.x), Math.floor(f.y)]);
  // Zoomed out, the tiles wait for the slow refresh.
  expect(next.tiles.every(([z]) => z >= 10)).toBe(true);
  expect((await live(next.rev)).tiles).toEqual([]);

  tiles.reset();
  expect((await live(next.rev)).all).toBe(true);
});

test("a long held track is thinned, not cut, so all of it stays drawn", () => {
  const kept = Array.from({ length: 10_000 }, (_, i) => i).filter(thin(10_000));
  expect(kept.length).toBeLessThanOrEqual(2000);
  expect(kept[0]).toBe(0);
  expect(kept.slice(-1000)).toEqual(
    Array.from({ length: 1000 }, (_, i) => 9000 + i),
  );
});

test("refreshes are batched by how much the plotter's view holds", async () => {
  expect(refreshMs(25 * 1024)).toBe(5_000);
  expect(refreshMs(400 * 1024)).toBe(15_000);
  expect(refreshMs(2 * 1024 * 1024)).toBe(30_000);
  // Plotters draw 512-pixel tiles, a zoom below the map's.
  expect(parseView("13.4,-76.3,36.9,-76.1,37")).toEqual([
    12, -76.3, 36.9, -76.1, 37,
  ]);
  expect(parseView("13,-76.3,36.9")).toBeUndefined();
  // Out of range, or north below south: no view.
  expect(parseView("13,-1e18,40,1e18,30")).toBeUndefined();
  expect(parseView("13,-76.3,37,-76.1,36.9")).toBeUndefined();
  expect(parseView("13,,,,")).toBeUndefined();
  expect(parseView("13,-76.3,36.9,-76.1,90")).toBeUndefined();

  const { store, get } = serve();
  const { py, px } = cellAt(-76.2, 36.98);
  store.addPasses([{ py, px, depth: 6, day: 20000 }]);
  const f = tileFraction(-76.2, 36.98, 12);
  const tile = await get(`${TILES_PATH}/:z/:x/:y.pbf`, {
    params: { z: "12", x: `${Math.floor(f.x)}`, y: `${Math.floor(f.y)}` },
  });
  expect((tile.body as Buffer).length).toBeGreaterThan(0);
  const live = async (view?: string) =>
    (await get(LIVE_PATH, { query: { since: "-1", ...(view && { view }) } }))
      .body as { refreshMs?: number; stored: unknown[] };
  // The view's one built tile is light.
  expect((await live("13,-76.25,36.95,-76.15,37")).refreshMs).toBe(5_000);
  // No view, or a box too large for one: the runtime's own batch.
  expect((await live()).refreshMs).toBeUndefined();
  expect((await live("13,-80,30,-70,40")).refreshMs).toBeUndefined();
  expect((await live("13,-1e18,40,1e18,30")).refreshMs).toBeUndefined();
});

test("the preview goes to a runtime that asks, when it's changed, in its unit", async () => {
  const line = (properties: GeoFeature["properties"]): GeoFeature => ({
    type: "Feature",
    geometry: { type: "MultiLineString", coordinates: [] },
    properties,
  });
  const features = [
    line({ VALDCO: 2, unit: "m" }),
    line({ VALDCO: 0.9144, unit: "ft" }),
    line({ VALDCO: 10 }),
  ];
  let asked = 0;
  const { get } = serve(DEFAULT_OWN_STYLE, {
    get: async () => (asked++, { rev: 3, features }),
    latest: () => ({ rev: 3, features }),
  });
  const live = async (query: Record<string, string>) =>
    (await get(LIVE_PATH, { query: { since: "-1", ...query } })).body as {
      preview?: { rev: number; type: string; features: GeoFeature[] };
    };
  // A runtime that doesn't draw it isn't sent it, nor is it worked out for one.
  expect((await live({})).preview).toBeUndefined();
  expect(asked).toBe(0);
  const sent = (await live({ preview: "-1", unit: "ft" })).preview!;
  expect(sent.rev).toBe(3);
  expect(sent.type).toBe("FeatureCollection");
  expect(sent.features.map((f) => f.properties.VALDCO)).toEqual([0.9144, 10]);
  expect((await live({ preview: "-1" })).preview!.features).toHaveLength(3);
  // The runtime holds it already.
  expect((await live({ preview: "3", unit: "m" })).preview).toBeUndefined();
});

test("a poll waits a second at most for the preview, then sends the last", async () => {
  vi.useFakeTimers();
  try {
    const { get } = serve(DEFAULT_OWN_STYLE, {
      get: () => new Promise(() => {}),
      latest: () => ({ rev: 1, features: [] }),
    });
    const res = get(LIVE_PATH, { query: { since: "-1", preview: "0" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(((await res).body as { preview: { rev: number } }).preview.rev).toBe(
      1,
    );
  } finally {
    vi.useRealTimers();
  }
});

test("a live poll that fails is answered, not left hanging", async () => {
  const { get } = serve(DEFAULT_OWN_STYLE, {
    get: () => Promise.reject(new Error("broken")),
    latest: () => ({ rev: 1, features: [] }),
  });
  const res = await get(LIVE_PATH, { query: { since: "-1", preview: "0" } });
  expect(res.code).toBe(500);
});
