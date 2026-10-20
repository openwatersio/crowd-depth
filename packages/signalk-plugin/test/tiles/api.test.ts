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

function serve() {
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
  };
  expect(style.sources.cells.tiles).toEqual([`${TILES_PATH}/{z}/{x}/{y}.pbf`]);
  expect(style.state.safetyDepth.default).toBe(3);
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
