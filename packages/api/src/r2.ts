import { getLogger } from "./logger.js";

const logger = getLogger("r2");

/** What the API needs from a storage backend. */
export type Storage = Pick<R2Storage, "store" | "storeDone" | "storeFailed">;

// Structural subset of workerd's R2Bucket so this compiles without
// @cloudflare/workers-types.
export type R2BucketLike = {
  put(
    key: string,
    value: Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
};

/**
 * Stores submissions via a native R2 binding; no credentials involved.
 *
 * Each submission lives under a date-based key with sidecar markers:
 * `<key>.geojson` is the data, `<key>.done.json` records a terminal outcome
 * (accepted, or permanently rejected by NOAA), and `<key>.failed.json`
 * records a retryable failure awaiting the sweep cron.
 */
export class R2Storage {
  constructor(private bucket: R2BucketLike) {}

  async store(uuid: string, data: Uint8Array): Promise<string> {
    const key = generateKey(uuid);
    logger.debug("Storing to R2 with key %s", key);

    await this.bucket.put(`${key}.geojson`, data, {
      httpMetadata: { contentType: "application/geo+json" },
    });

    return key;
  }

  /** Record a terminal outcome; the sweep will not touch this key again. */
  async storeDone(key: string, result: object): Promise<void> {
    await this.putJSON(`${key}.done.json`, result);
  }

  /** Record a retryable failure; the sweep will resubmit this key. */
  async storeFailed(key: string, failure: object): Promise<void> {
    await this.putJSON(`${key}.failed.json`, failure);
  }

  async getData(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(`${key}.geojson`);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  async getJSON(objectKey: string): Promise<Record<string, unknown> | null> {
    const object = await this.bucket.get(objectKey);
    return object ? JSON.parse(await object.text()) : null;
  }

  /** List every object under a prefix, following pagination. */
  async list(prefix: string): Promise<{ key: string; uploaded: Date }[]> {
    const objects: { key: string; uploaded: Date }[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.bucket.list({ prefix, cursor });
      objects.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return objects;
  }

  private putJSON(objectKey: string, value: object) {
    return this.bucket.put(objectKey, JSON.stringify(value), {
      httpMetadata: { contentType: "application/json" },
    });
  }
}

function generateKey(uuid: string) {
  const now = new Date();
  const [date, time] = now.toISOString().split("T");
  const [y, m, d] = date.split("-");

  return `${y}/${m}/${d}/${time}-${uuid}`;
}
