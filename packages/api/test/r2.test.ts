import { describe, expect, test } from "vitest";
import { R2Storage } from "../src/r2.js";

describe("R2Storage", () => {
  test("stores data and markers under the same key", async () => {
    const puts: Array<[string, Uint8Array | string, unknown]> = [];
    const storage = new R2Storage({
      put: async (key, value, options) => puts.push([key, value, options]),
      get: async () => null,
      list: async () => ({ objects: [], truncated: false }),
    });

    const key = await storage.store("abc", new Uint8Array([1, 2, 3]));
    await storage.storeDone(key, { success: true });
    await storage.storeFailed(key, { attempts: 1 });

    expect(key).toMatch(/^\d{4}\/\d{2}\/\d{2}\/.+-abc$/);
    expect(puts).toEqual([
      [
        `${key}.geojson`,
        new Uint8Array([1, 2, 3]),
        { httpMetadata: { contentType: "application/geo+json" } },
      ],
      [
        `${key}.done.json`,
        JSON.stringify({ success: true }),
        { httpMetadata: { contentType: "application/json" } },
      ],
      [
        `${key}.failed.json`,
        JSON.stringify({ attempts: 1 }),
        { httpMetadata: { contentType: "application/json" } },
      ],
    ]);
  });
});
