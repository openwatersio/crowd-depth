import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import {
  BASE_ZOOM,
  RECORD_BYTES,
  TILE_SIZE,
  createMemoryTileStore,
  encodeDepth,
  lngLatToCell,
  mergeCell,
  type TileCells,
} from "../../src/tiles/core/index.js";
import {
  BATHYMETRY_BASE,
  registerBathymetryRoutes,
} from "../../src/tiles/api.js";

interface Res {
  set(key: string, value: string): Res;
  status(code: number): Res;
  json(body: unknown): Res;
  end(): Res;
  send(body: unknown): Res;
}

/** Capture the top-level routes `registerBathymetryRoutes` registers on the
 * Express-capable server API. */
function captureApp() {
  const handlers = new Map<
    string,
    (req: { params: Record<string, string> }, res: Res) => void
  >();
  const app = {
    get(
      path: string,
      handler: (req: { params: Record<string, string> }, res: Res) => void,
    ) {
      handlers.set(path, handler);
    },
  } as unknown as ServerAPI;
  return { app, handlers };
}

test("serves a tile as raw bytes, not JSON", () => {
  const store = createMemoryTileStore();
  const { x, y, cx, cy } = lngLatToCell(0.001, 0.001, BASE_ZOOM);
  const cells: TileCells = new Map();
  mergeCell(cells, cy * TILE_SIZE + cx, encodeDepth(5));
  store.write(BASE_ZOOM, x, y, cells);

  const { app, handlers } = captureApp();
  registerBathymetryRoutes(app, () => store);
  const handler = handlers.get(`${BATHYMETRY_BASE}/tiles/:z/:x/:y`);
  expect(handler).toBeDefined();

  let body: unknown;
  const res: Res = {
    set: () => res,
    status: () => res,
    json: () => res,
    end: () => res,
    send: (b) => {
      body = b;
      return res;
    },
  };
  handler!({ params: { z: `${BASE_ZOOM}`, x: `${x}`, y: `${y}` } }, res);

  // express's res.send JSON-encodes a plain Uint8Array; the body must be a
  // Buffer so the client receives the sparse-v1 records verbatim.
  expect(Buffer.isBuffer(body)).toBe(true);
  const bytes = body as Buffer;
  expect(bytes.length).toBe(RECORD_BYTES);
  expect(bytes[0]).toBe(cx);
  expect(bytes[1]).toBe(cy);
});
