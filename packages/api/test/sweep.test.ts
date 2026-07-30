import { describe, test, expect } from "vitest";
import nock from "nock";
import { sweep } from "../src/sweep.js";
import { R2Storage, type R2BucketLike } from "../src/r2.js";

const NOAA = "https://example.com/bathy/";
const UUID = "60ba2ee8-04ee-45e4-b723-d54ee031ea47";

const SUCCESS_RESPONSE = {
  success: true,
  message: "Submission successful.",
  submissionIds: ["123"],
};

function fakeBucket() {
  const objects = new Map<
    string,
    { value: Uint8Array | string; uploaded: Date }
  >();

  const bucket: R2BucketLike = {
    async put(key, value) {
      objects.set(key, { value, uploaded: new Date() });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      const bytes =
        typeof object.value === "string"
          ? new TextEncoder().encode(object.value)
          : object.value;
      return {
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
      };
    },
    async list({ prefix = "" } = {}) {
      return {
        objects: [...objects]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, { uploaded }]) => ({ key, uploaded })),
        truncated: false,
      };
    },
  };

  return { bucket, objects };
}

function keyAt(uploaded: Date, uuid = UUID) {
  const [date, time] = uploaded.toISOString().split("T");
  return `${date.replaceAll("-", "/")}/${time}-${uuid}`;
}

function addSubmission(
  objects: Map<string, { value: Uint8Array | string; uploaded: Date }>,
  {
    ageMs = 60 * 60 * 1000,
    failed,
    done,
  }: { ageMs?: number; failed?: object; done?: object } = {},
) {
  const uploaded = new Date(Date.now() - ageMs);
  const key = keyAt(uploaded);
  objects.set(`${key}.geojson`, { value: '{"type":"Feature"}', uploaded });
  if (failed)
    objects.set(`${key}.failed.json`, {
      value: JSON.stringify(failed),
      uploaded,
    });
  if (done)
    objects.set(`${key}.done.json`, { value: JSON.stringify(done), uploaded });
  return key;
}

function useSweep(bucket: R2BucketLike) {
  return sweep({ storage: new R2Storage(bucket), url: NOAA, token: "t" });
}

describe("sweep", () => {
  test("resubmits a failed submission and marks it done", async () => {
    const { bucket, objects } = fakeBucket();
    const key = addSubmission(objects, {
      failed: { attempts: 2, noaaStatus: 500 },
    });

    const scope = nock("https://example.com")
      .post("/bathy/geojson")
      .matchHeader("x-auth-token", "t")
      .reply(200, SUCCESS_RESPONSE, { "Content-Type": "application/json" });

    const summary = await useSweep(bucket);

    expect(scope.isDone()).toBe(true);
    expect(summary).toEqual({ submitted: 1, rejected: 0, deferred: 0 });

    const result = JSON.parse(String(objects.get(`${key}.done.json`)?.value));
    expect(result).toMatchObject({
      success: true,
      uuid: UUID,
      uniqueID: `SIGNALK-${UUID}`,
      attempts: 3,
      submission: SUCCESS_RESPONSE,
    });
  });

  test("resubmits an old submission with no marker at all", async () => {
    const { bucket, objects } = fakeBucket();
    addSubmission(objects, { ageMs: 60 * 60 * 1000 });

    const scope = nock("https://example.com")
      .post("/bathy/geojson")
      .reply(200, SUCCESS_RESPONSE, { "Content-Type": "application/json" });

    const summary = await useSweep(bucket);

    expect(scope.isDone()).toBe(true);
    expect(summary.submitted).toBe(1);
  });

  test("skips submissions that are already done", async () => {
    const { bucket, objects } = fakeBucket();
    addSubmission(objects, { done: { success: true } });

    const summary = await useSweep(bucket);

    expect(summary).toEqual({ submitted: 0, rejected: 0, deferred: 0 });
    expect(nock.pendingMocks()).toEqual([]);
  });

  test("skips submissions with a legacy .result.json marker", async () => {
    const { bucket, objects } = fakeBucket();
    const key = addSubmission(objects, { ageMs: 60 * 60 * 1000 });
    objects.set(`${key}.result.json`, {
      value: JSON.stringify({ success: true }),
      uploaded: new Date(),
    });

    const summary = await useSweep(bucket);

    expect(summary).toEqual({ submitted: 0, rejected: 0, deferred: 0 });
  });

  test("skips young markerless submissions that may be in flight", async () => {
    const { bucket, objects } = fakeBucket();
    addSubmission(objects, { ageMs: 60 * 1000 });

    const summary = await useSweep(bucket);

    expect(summary).toEqual({ submitted: 0, rejected: 0, deferred: 0 });
  });

  test("marks a 4xx rejection as done so it is never retried", async () => {
    const { bucket, objects } = fakeBucket();
    const key = addSubmission(objects, { failed: { attempts: 1 } });

    nock("https://example.com")
      .post("/bathy/geojson")
      .reply(422, { message: "Invalid GeoJSON", success: false });

    const summary = await useSweep(bucket);

    expect(summary).toEqual({ submitted: 0, rejected: 1, deferred: 0 });
    const result = JSON.parse(String(objects.get(`${key}.done.json`)?.value));
    expect(result).toMatchObject({ success: false, noaaStatus: 422 });
  });

  test("defers again on a 5xx, incrementing attempts", async () => {
    const { bucket, objects } = fakeBucket();
    const key = addSubmission(objects, { failed: { attempts: 4 } });

    nock("https://example.com")
      .post("/bathy/geojson")
      .reply(500, { message: "Internal Server Error", success: false });

    const summary = await useSweep(bucket);

    expect(summary).toEqual({ submitted: 0, rejected: 0, deferred: 1 });
    expect(objects.has(`${key}.done.json`)).toBe(false);
    const failure = JSON.parse(
      String(objects.get(`${key}.failed.json`)?.value),
    );
    expect(failure).toMatchObject({ noaaStatus: 500, attempts: 5 });
    expect(failure).toHaveProperty("lastAttempt");
  });
});
