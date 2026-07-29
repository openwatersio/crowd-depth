import { generateKey, type Storage } from "./s3.js";
import { getLogger } from "./logger.js";

const logger = getLogger("r2");

// Structural subset of workerd's R2Bucket so this compiles without
// @cloudflare/workers-types.
export type R2BucketLike = {
  put(
    key: string,
    value: Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
};

/** Stores submissions via a native R2 binding; no credentials involved. */
export class R2Storage implements Storage {
  constructor(private bucket: R2BucketLike) {}

  async store(uuid: string, data: Uint8Array): Promise<string> {
    const key = generateKey(uuid);
    logger.debug("Storing to R2 with key %s", key);

    await this.bucket.put(`${key}.geojson`, data, {
      httpMetadata: { contentType: "application/geo+json" },
    });

    return key;
  }

  async storeResult(key: string, result: object): Promise<void> {
    await this.bucket.put(`${key}.result.json`, JSON.stringify(result), {
      httpMetadata: { contentType: "application/json" },
    });
  }
}
