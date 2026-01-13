import { describe, test, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import nock from "nock";
import { createApi, createIdentity } from "../src/api";
import { getMetadata } from "../src";
import { config, vessel } from "./helper";
import S3rver from "s3rver";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

// This is a real response from NOAA for a valid submission
const SUCCESS_RESPONSE = {
  success: true,
  message: "Submission successful.",
  submissionIds: ["123"],
};

const app = express();
app.use(
  createApi({
    url: "https://example.com/bathy",
    token: "test-token",
  }),
);

beforeAll(() => {
  nock.enableNetConnect("127.0.0.1");
});

describe("POST /xyz", () => {
  test("rejects requests without token", async () => {
    await request(app)
      .post("/xyz")
      .expect(401)
      .expect({ success: false, message: "No token provided" });
  });

  test("rejects requests with malformed token", async () => {
    await request(app)
      .post("/xyz")
      .set("Authorization", "malformed-token")
      .expect(401)
      .expect({ success: false, message: "No token provided" });
  });

  test("rejects requests with invalid token", async () => {
    await request(app)
      .post("/xyz")
      .set("Authorization", "Bearer invalid-token")
      .expect(403)
      .expect({ success: false, message: "Invalid token" });
  });

  test("rejects requests with missing data", async () => {
    await request(app)
      .post("/xyz")
      .set("Authorization", `Bearer ${createIdentity(vessel.uuid).token}`)
      .expect(400)
      .expect({ success: false, message: "Missing Content-Type" });
  });

  test("rejects request with mismatched uuid", async () => {
    const metadata = getMetadata(vessel, config);
    const { token } = createIdentity("WRONG");

    await request(app)
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

    await request(app)
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

  test("also stores metadata and csv to S3-compatible endpoint", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3rver-"));
    const bucket = "test-bucket";
    const server = new S3rver({
      address: "127.0.0.1",
      port: 4569,
      silent: true,
      directory: tmp,
      configureBuckets: [{ name: bucket }],
    });

    await server.run();
    const endpoint = `http://127.0.0.1:4569`;

    // Point storage at our local S3 server
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "S3RVER";
    process.env.S3_SECRET_ACCESS_KEY = "S3RVER";
    process.env.S3_BUCKET = bucket;

    // Mock NOAA endpoint
    const scope = nock("https://example.com")
      .post("/xyz")
      .matchHeader("x-auth-token", "test-token")
      .reply(200, SUCCESS_RESPONSE, { "Content-Type": "application/json" });

    // Create an app instance AFTER env vars are set, so storage picks them up
    const app2 = express();
    app2.use(
      createApi({ url: "https://example.com/bathy", token: "test-token" }),
    );

    const metadata = getMetadata(vessel, config);

    await request(app2)
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

    expect(scope.isDone()).toBe(true);

    // Verify objects via AWS SDK v3 against local s3rver
    const s3 = new S3Client({
      region: process.env.S3_REGION!,
      endpoint: process.env.S3_ENDPOINT!,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
    });

    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${vessel.uuid}-` }),
    );
    const keys: string[] = (listed.Contents || []).map((o) => o.Key!);
    expect(keys.some((k: string) => k.endsWith(".json"))).toBe(true);
    expect(keys.some((k: string) => k.endsWith(".csv"))).toBe(true);

    const jsonKey = keys.find((k: string) => k.endsWith(".json"));
    const csvKey = keys.find((k: string) => k.endsWith(".csv"));

    const jsonObj = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: jsonKey }),
    );
    const csvObj = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: csvKey }),
    );

    const jsonText = await jsonObj.Body!.transformToString("utf8");
    const csvText = await csvObj.Body!.transformToString("utf8");

    const expectedJson = JSON.parse(JSON.stringify(metadata));
    expect(JSON.parse(jsonText)).toMatchObject(expectedJson);
    expect(csvText).toBe("dummy data");

    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });
});

describe("POST /identify", () => {
  test("returns a token", async () => {
    await request(app)
      .post("/identify")
      .expect("Content-Type", /json/)
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty("uuid");
        expect(res.body).toHaveProperty("token");
      });
  });
});
