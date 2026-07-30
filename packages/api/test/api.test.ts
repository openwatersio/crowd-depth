import { describe, test, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import nock from "nock";
import {
  createApi,
  createIdentity,
  MAX_UPLOAD_BYTES,
  MIN_CLIENT_VERSION,
  type APIOptions,
} from "../src/api.js";
import { createApp } from "../src/app.js";
import { toUniqueID } from "crowd-depth";
import { vessel } from "../../signalk-plugin/test/helper.js";

// This is a real response from NOAA for a valid submission
const SUCCESS_RESPONSE = {
  success: true,
  message: "Submission successful.",
  submissionIds: ["123"],
};

beforeAll(() => {
  nock.enableNetConnect("127.0.0.1");
});

const defaultOptions = {
  url: "https://example.com/bathy",
  token: "test-token",
};

function useApp(options: APIOptions = {}) {
  return request(express().use(createApi({ ...defaultOptions, ...options })));
}

describe("POST /geojson", () => {
  describe("client version validation", () => {
    test("rejects requests without User-Agent", async () => {
      await useApp()
        .post("/geojson")
        .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
        .expect(400)
        .expect({ success: false, message: "Missing or invalid User-Agent" });
    });

    test("rejects requests with invalid User-Agent format", async () => {
      await useApp()
        .post("/geojson")
        .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
        .set("User-Agent", "SomeOtherClient/1.0.0")
        .expect(400)
        .expect({ success: false, message: "Missing or invalid User-Agent" });
    });

    test("rejects requests with unparseable version", async () => {
      await useApp()
        .post("/geojson")
        .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
        .set("User-Agent", "crowd-depth/not-a-version (https://github.com)")
        .expect(400)
        .expect({ success: false, message: "Missing or invalid User-Agent" });
    });

    test("rejects requests with version below minimum (1.0.0)", async () => {
      await useApp()
        .post("/geojson")
        .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
        .set(
          "User-Agent",
          "crowd-depth/1.0.0 (https://github.com/openwatersio/crowd-depth)",
        )
        .expect(426)
        .expect({
          success: false,
          message: "Client version too old",
          minVersion: MIN_CLIENT_VERSION,
        });
    });

    test("accepts requests with minimum version", async () => {
      await useApp()
        .post("/geojson")
        .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
        .set(
          "User-Agent",
          `crowd-depth/${MIN_CLIENT_VERSION} (https://github.com/openwatersio/crowd-depth)`,
        )
        .expect(400) // Will fail at the next validation step (missing data)
        .expect({ success: false, message: "Missing Content-Type" });
    });

    test("accepts requests with version above minimum", async () => {
      await useApp()
        .post("/geojson")
        .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
        .set(
          "User-Agent",
          "crowd-depth/2000.0.0 (https://github.com/openwatersio/crowd-depth)",
        )
        .expect(400) // Will fail at the next validation step (missing data)
        .expect({ success: false, message: "Missing Content-Type" });
    });
  });

  test("rejects requests without token", async () => {
    await useApp()
      .post("/geojson")
      .expect(401)
      .expect({ success: false, message: "No token provided" });
  });

  test("rejects requests with malformed token", async () => {
    await useApp()
      .post("/geojson")
      .set("Authorization", "malformed-token")
      .expect(401)
      .expect({ success: false, message: "No token provided" });
  });

  test("rejects requests with invalid token", async () => {
    await useApp()
      .post("/geojson")
      .set("Authorization", "Bearer invalid-token")
      .expect(403)
      .expect({ success: false, message: "Invalid token" });
  });

  test("rejects requests with missing data", async () => {
    await useApp()
      .post("/geojson")
      .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
      .set(
        "User-Agent",
        `crowd-depth/${MIN_CLIENT_VERSION} (https://github.com/openwatersio/crowd-depth)`,
      )
      .expect(400)
      .expect({ success: false, message: "Missing Content-Type" });
  });

  test("rejects request with mismatched uuid", async () => {
    const uniqueID = toUniqueID(vessel);
    const { token } = createIdentity("WRONG");

    await useApp()
      .post("/geojson")
      .set("Authorization", `Bearer ${token}`)
      .set(
        "User-Agent",
        `crowd-depth/${MIN_CLIENT_VERSION} (https://github.com/openwatersio/crowd-depth)`,
      )
      .field("metadataInput", JSON.stringify({ uniqueID }), {
        filename: "test.json",
        contentType: "application/json",
      })
      .field("file", "dummy data", {
        filename: "test.json",
        contentType: "application/geo+json",
      })
      .expect(403)
      .expect({ success: false, message: "Invalid uniqueID" });
  });

  test("rejects files over the size cap", async () => {
    await useApp()
      .post("/geojson")
      .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
      .set(
        "User-Agent",
        `crowd-depth/${MIN_CLIENT_VERSION} (https://github.com/openwatersio/crowd-depth)`,
      )
      .field(
        "metadataInput",
        JSON.stringify({ uniqueID: toUniqueID(vessel) }),
        {
          filename: "test.json",
          contentType: "application/json",
        },
      )
      .attach("file", Buffer.alloc(MAX_UPLOAD_BYTES + 1, "x"), {
        filename: "test.geojson",
        contentType: "application/geo+json",
      })
      .expect(413)
      .expect((res) => {
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/maximum size/);
      });
  });

  test("proxies to NOAA with valid token", async () => {
    const scope = nock("https://example.com")
      .post("/geojson")
      .matchHeader("x-auth-token", "test-token")
      .matchHeader("authorization", (val) => !val) // Ensure Authorization header is removed
      .reply(200, SUCCESS_RESPONSE, { "Content-Type": "application/json" });

    const uniqueID = toUniqueID(vessel);

    await useApp()
      .post("/geojson")
      .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
      .set(
        "User-Agent",
        `crowd-depth/${MIN_CLIENT_VERSION} (https://github.com/openwatersio/crowd-depth)`,
      )
      .field("metadataInput", JSON.stringify({ uniqueID }), {
        filename: "test.json",
        contentType: "application/json",
      })
      .field("file", "dummy data", {
        filename: "test.json",
        contentType: "application/geo+json",
      })
      .expect(200)
      .expect(SUCCESS_RESPONSE)
      .expect("Content-Type", /json/);

    expect(scope.isDone()).toBe(true);
  });

  test("returns 502 when NOAA rejects the submission", async () => {
    const scope = nock("https://example.com")
      .post("/geojson")
      .reply(500, {
        formErrors: ["Internal Server Error"],
        fieldErrors: {},
        message: "Internal Server Error",
        success: false,
      });

    const uniqueID = toUniqueID(vessel);

    await useApp()
      .post("/geojson")
      .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
      .set(
        "User-Agent",
        `crowd-depth/${MIN_CLIENT_VERSION} (https://github.com/openwatersio/crowd-depth)`,
      )
      .field("metadataInput", JSON.stringify({ uniqueID }), {
        filename: "test.json",
        contentType: "application/json",
      })
      .field("file", "dummy data", {
        filename: "test.json",
        contentType: "application/geo+json",
      })
      .expect(502)
      .expect((res) => {
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/500 Internal Server Error/);
      });

    expect(scope.isDone()).toBe(true);
  });

  // In-memory storage fake standing in for the R2 binding
  function fakeStorage() {
    const stored: Array<{ uuid: string; data: Uint8Array }> = [];
    const done: Array<{ key: string; result: object }> = [];
    const failed: Array<{ key: string; failure: object }> = [];
    return {
      stored,
      done,
      failed,
      async store(uuid: string, data: Uint8Array) {
        stored.push({ uuid, data });
        return `2026/01/01/00:00:00.000Z-${uuid}`;
      },
      async storeDone(key: string, result: object) {
        done.push({ key, result });
      },
      async storeFailed(key: string, failure: object) {
        failed.push({ key, failure });
      },
    };
  }

  function postGeoJSON(uniqueID: string, storage?: APIOptions["storage"]) {
    return useApp({ storage })
      .post("/geojson")
      .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
      .set(
        "User-Agent",
        `crowd-depth/${MIN_CLIENT_VERSION} (https://github.com/openwatersio/crowd-depth)`,
      )
      .field("metadataInput", JSON.stringify({ uniqueID }), {
        filename: "test.json",
        contentType: "application/json",
      })
      .field("file", "dummy data", {
        filename: "test.xyz",
        contentType: "application/geo+json",
      });
  }

  test("stores data and result", async () => {
    const uniqueID = toUniqueID(vessel);
    const storage = fakeStorage();

    // Mock NOAA endpoint
    const noaaScope = nock("https://example.com")
      .post("/geojson")
      .matchHeader("x-auth-token", "test-token")
      .reply(200, SUCCESS_RESPONSE, { "Content-Type": "application/json" });

    await postGeoJSON(uniqueID, storage).expect(200).expect(SUCCESS_RESPONSE);

    expect(noaaScope.isDone()).toBe(true);
    expect(storage.stored).toHaveLength(1);
    expect(storage.stored[0].uuid).toBe(vessel.uuid);
    expect(storage.failed).toHaveLength(0);
    expect(storage.done).toHaveLength(1);
    expect(storage.done[0].key).toContain(vessel.uuid);
    expect(storage.done[0].result).toMatchObject({
      success: true,
      uuid: vessel.uuid,
      uniqueID,
      submission: SUCCESS_RESPONSE,
    });
    expect(storage.done[0].result).toHaveProperty("bytes");
    expect(storage.done[0].result).toHaveProperty("durationMs");
  });

  test("returns 500 when storage fails", async () => {
    const uniqueID = toUniqueID(vessel);

    // NOAA should never be called if the data couldn't be stored
    const noaaScope = nock("https://example.com").post("/geojson").reply(200);

    const storage = {
      async store(): Promise<string> {
        throw new Error("AccessDenied");
      },
      async storeDone() {},
      async storeFailed() {},
    };

    await postGeoJSON(uniqueID, storage)
      .expect(500)
      .expect((res) => {
        expect(res.body.success).toBe(false);
      });

    expect(noaaScope.isDone()).toBe(false);
    nock.cleanAll();
  });

  test("returns 200 and queues when NOAA fails but data is stored", async () => {
    const uniqueID = toUniqueID(vessel);
    const storage = fakeStorage();

    const noaaScope = nock("https://example.com")
      .post("/geojson")
      .reply(500, { message: "Internal Server Error", success: false });

    await postGeoJSON(uniqueID, storage)
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/queued/);
        expect(res.body.submissionId).toMatch(
          new RegExp(`^\\d{4}/\\d{2}/\\d{2}/.*${vessel.uuid}$`),
        );
      });

    expect(noaaScope.isDone()).toBe(true);
    expect(storage.stored).toHaveLength(1);
    expect(storage.done).toHaveLength(0);
    expect(storage.failed).toHaveLength(1);
    expect(storage.failed[0].failure).toMatchObject({
      success: false,
      uuid: vessel.uuid,
      uniqueID,
      noaaStatus: 500,
      attempts: 1,
    });
    expect(storage.failed[0].failure).toHaveProperty("noaaBody");
    expect(storage.failed[0].failure).toHaveProperty("lastAttempt");
  });

  test("records a terminal outcome when NOAA rejects with a 4xx", async () => {
    const uniqueID = toUniqueID(vessel);
    const storage = fakeStorage();

    const noaaScope = nock("https://example.com")
      .post("/geojson")
      .reply(422, { message: "Invalid GeoJSON", success: false });

    await postGeoJSON(uniqueID, storage)
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/rejected/);
      });

    expect(noaaScope.isDone()).toBe(true);
    expect(storage.failed).toHaveLength(0);
    expect(storage.done).toHaveLength(1);
    expect(storage.done[0].result).toMatchObject({
      success: false,
      noaaStatus: 422,
    });
  });
});

describe("mount points", () => {
  const app = () => request(createApp(defaultOptions));
  const reachable = { success: true, message: "API is reachable" };

  test("serves the api under /bathymetry", async () => {
    await app().get("/bathymetry").expect(200).expect(reachable);
  });

  test("serves the api at the root of the legacy host", async () => {
    await app()
      .get("/")
      .set("Host", "depth.openwaters.io")
      .expect(200)
      .expect(reachable);
  });

  test("serves the api at the root of generated and local hosts", async () => {
    await app()
      .get("/")
      .set("Host", "crowd-depth.workers.dev")
      .expect(200)
      .expect(reachable);
  });

  test("reserves the root of the shared api host", async () => {
    await app().get("/").set("Host", "api.openwaters.io").expect(404);
  });

  test("serves /bathymetry on the shared api host", async () => {
    await app()
      .get("/bathymetry")
      .set("Host", "api.openwaters.io")
      .expect(200)
      .expect(reachable);
  });
});

describe("POST /identify", () => {
  test("returns a token", async () => {
    await useApp()
      .post("/identify")
      .expect("Content-Type", /json/)
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty("uuid");
        expect(res.body).toHaveProperty("token");
      });
  });
});
