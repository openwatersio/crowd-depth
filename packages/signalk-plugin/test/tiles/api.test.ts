import { expect, test } from "vitest";
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
import { thin } from "../../src/tiles/api.js";
import { DEFAULT_OWN_STYLE } from "../../src/tiles/style.js";
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

function serve(own = DEFAULT_OWN_STYLE) {
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
