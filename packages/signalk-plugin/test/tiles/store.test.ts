import { expect, test } from "vitest";
import { BASE_ZOOM, TILE_SIZE } from "../../src/tiles/core/index.js";
import { createDB } from "../../src/storage.js";
import { createTileStore } from "../../src/tiles/store.js";

const tile = (x: number, y: number) => ({ x, y });

test("merging keeps the shallowest depth and sums counts", () => {
  const store = createTileStore(createDB(":memory:"));
  const { x, y } = tile(524288, 524288);
  const key = 10 * TILE_SIZE + 20;

  store.merge(BASE_ZOOM, x, y, new Map([[key, { depth: 1500, count: 1 }]]));
  store.merge(BASE_ZOOM, x, y, new Map([[key, { depth: 900, count: 1 }]]));

  expect(store.read(BASE_ZOOM, x, y)?.get(key)).toEqual({
    depth: 900,
    count: 2,
  });
  store.close();
});

test("writing an empty tile deletes it", () => {
  const store = createTileStore(createDB(":memory:"));
  store.merge(BASE_ZOOM, 1, 1, new Map([[0, { depth: 100, count: 1 }]]));
  expect(store.read(BASE_ZOOM, 1, 1)).toBeDefined();
  store.write(BASE_ZOOM, 1, 1, new Map());
  expect(store.read(BASE_ZOOM, 1, 1)).toBeUndefined();
  store.close();
});

test("updateAncestors min-pools the changed tile up the pyramid", () => {
  const store = createTileStore(createDB(":memory:"));
  const x = 524288;
  const y = 524288;
  store.merge(BASE_ZOOM, x, y, new Map([[0, { depth: 1234, count: 1 }]]));
  store.updateAncestors(BASE_ZOOM, x, y);

  // the parent of (524288,524288) at z-1 is (262144,262144); the child's (0,0)
  // cell pools into the parent's (0,0) cell
  expect(store.read(BASE_ZOOM - 1, 262144, 262144)?.get(0)).toEqual({
    depth: 1234,
    count: 1,
  });
  store.close();
});

test("a transaction rolls back on error", () => {
  const store = createTileStore(createDB(":memory:"));
  expect(() =>
    store.transaction(() => {
      store.merge(BASE_ZOOM, 1, 1, new Map([[0, { depth: 100, count: 1 }]]));
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(store.read(BASE_ZOOM, 1, 1)).toBeUndefined();
  store.close();
});
