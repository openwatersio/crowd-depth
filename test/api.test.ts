import { describe, test, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import nock from "nock";
import { createApi, createIdentity, type APIOptions } from "../src/api";
import { getMetadata } from "../src";
import { config, vessel } from "./helper";

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

describe("POST /xyz", () => {
  test("rejects requests without token", async () => {
    await useApp()
      .post("/xyz")
      .expect(401)
      .expect({ success: false, message: "No token provided" });
  });

  test("rejects requests with malformed token", async () => {
    await useApp()
      .post("/xyz")
      .set("Authorization", "malformed-token")
      .expect(401)
      .expect({ success: false, message: "No token provided" });
  });

  test("rejects requests with invalid token", async () => {
    await useApp()
      .post("/xyz")
      .set("Authorization", "Bearer invalid-token")
      .expect(403)
      .expect({ success: false, message: "Invalid token" });
  });

  test("rejects requests with missing data", async () => {
    await useApp()
      .post("/xyz")
      .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
      .expect(400)
      .expect({ success: false, message: "Missing Content-Type" });
  });

  test("rejects request with mismatched uuid", async () => {
    const metadata = getMetadata(vessel, config);
    const { token } = createIdentity("WRONG");

    await useApp()
      .post("/xyz")
      .set("Authorization", `Bearer ${token}`)
      .field("metadataInput", JSON.stringify(metadata), {
        filename: "test.json",
        contentType: "application/json",
      })
      .field("file", "dummy data", {
        filename: "test.xyz",
        contentType: "application/csv",
      })
      .expect(403)
      .expect({ success: false, message: "Invalid uniqueID" });
  });

  test("proxies to NOAA with valid token", async () => {
    const scope = nock("https://example.com")
      .post("/xyz")
      .matchHeader("x-auth-token", "test-token")
      .matchHeader("authorization", (val) => !val) // Ensure Authorization header is removed
      .reply(200, SUCCESS_RESPONSE, { "Content-Type": "application/json" });

    const metadata = getMetadata(vessel, config);

    await useApp()
      .post("/xyz")
      .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
      .field("metadataInput", JSON.stringify(metadata), {
        filename: "test.json",
        contentType: "application/json",
      })
      .field("file", "dummy data", {
        filename: "test.xyz",
        contentType: "application/csv",
      })
      .expect("Content-Type", /json/)
      .expect(200)
      .expect(SUCCESS_RESPONSE);

    expect(scope.isDone()).toBe(true);
  });

  test("stores data to S3-compatible endpoint", async () => {
    // Point storage at our mocked S3 endpoint
    const env = {
      S3_ENDPOINT: "https://s3.example.com",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "test-key",
      S3_SECRET_ACCESS_KEY: "test-secret",
      S3_BUCKET: "test-bucket",
    };

    const metadata = getMetadata(vessel, config);

    // Mock NOAA endpoint
    const noaaScope = nock("https://example.com")
      .post("/xyz")
      .matchHeader("x-auth-token", "test-token")
      .reply(200, SUCCESS_RESPONSE, { "Content-Type": "application/json" });

    // Mock S3 PUT requests - AWS SDK signs and uses specific paths
    // We need to be lenient with the matching since AWS SDK adds auth headers
    const s3Scope = nock(env.S3_ENDPOINT)
      .filteringPath(() => "/")
      .put("/")
      .times(2) // Expect 2 PUT calls (JSON and CSV)
      .reply(200);

    await useApp({ env })
      .post("/xyz")
      .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
      .field("metadataInput", JSON.stringify(metadata), {
        filename: "test.json",
        contentType: "application/json",
      })
      .field("file", "dummy data", {
        filename: "test.xyz",
        contentType: "application/csv",
      })
      .expect(200)
      .expect(SUCCESS_RESPONSE);

    expect(noaaScope.isDone()).toBe(true);
    expect(s3Scope.isDone()).toBe(true);
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
