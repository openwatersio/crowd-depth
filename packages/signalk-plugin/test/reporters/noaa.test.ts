import { describe, test, expect } from "vitest";
import Ajv from "ajv/dist/2020.js";
import {
  getMetadata,
  BathymetryData,
  BATHY_URL,
  submitGeoJSON,
  createGeoJSON,
} from "../../src/index.js";
import { Readable } from "stream";
import { text } from "stream/consumers";
import nock from "nock";
import { config, vessel } from "../helper.js";
import schema from "../../../../docs/CSB-schema-3_1_0-2024-04.json" with { type: "json" };
import { Temporal } from "@js-temporal/polyfill";

nock.disableNetConnect();

// This is a real response from NOAA for a valid submission
const SUCCESS_RESPONSE = {
  success: true,
  message: "Submission successful.",
  submissionIds: ["60ba2ee8-04ee-45e4-b723-d54ee031ea47"],
};

const data: BathymetryData[] = [
  {
    longitude: -122.123,
    latitude: 37.123,
    depth: 10,
    timestamp: Temporal.Instant.from("2024-01-01T00:00:00Z"),
  },
  {
    longitude: -122.124,
    latitude: 37.124,
    depth: 20,
    timestamp: Temporal.Instant.from("2024-01-01T00:01:01Z"),
  },
  {
    longitude: -122.125,
    latitude: 37.125,
    depth: 30,
    timestamp: Temporal.Instant.from("2024-01-01T00:02:02Z"),
  },
];

describe("submitGeoJSON", () => {
  test("success", async () => {
    const scope = nock(BATHY_URL).post("/geojson").reply(200, SUCCESS_RESPONSE);
    const res = await submitGeoJSON(
      BATHY_URL,
      config,
      vessel,
      Readable.from(data),
    );
    expect(res).toEqual(SUCCESS_RESPONSE);
    expect(scope.isDone()).toBe(true);
  });

  test("bad stream", async () => {
    const stream = new Readable({
      read() {
        this.emit("error", new Error("Stream error"));
      },
    });
    await expect(async () => {
      await submitGeoJSON(BATHY_URL, config, vessel, stream);
    }).rejects.toThrowError("Stream error");
  });

  test("unauthorized", async () => {
    const scope = nock(BATHY_URL)
      .post("/geojson")
      .reply(403, {
        formErrors: ["Forbidden"],
        fieldErrors: {},
        message: "Forbidden",
        success: false,
      });

    await expect(() =>
      submitGeoJSON(BATHY_URL, config, vessel, Readable.from(data)),
    ).rejects.toThrowError(/POST to.*failed: 403/);
    expect(scope.isDone()).toBe(true);
  });
});

describe("getMetadata", () => {
  test("includes platform data", () => {
    const metadata = getMetadata(vessel, config);
    expect(metadata.properties.platform.uniqueID).toEqual(
      "SIGNALK-60ba2ee8-04ee-45e4-b723-d54ee031ea47",
    );
    expect(metadata.properties.platform.IDNumber).toEqual("123456789");
    expect(metadata.properties.platform.IDType).toEqual("MMSI");
    expect(metadata.properties.platform.name).toEqual("Test Vessel");
    expect(metadata.properties.platform.type).toEqual("Sailing");
  });

  test("anonymous does not include MMSI, name, etc", () => {
    const metadata = getMetadata(vessel, {
      ...config,
      sharing: {
        ...config.sharing,
        anonymous: true,
      },
    });
    expect(metadata.properties.platform.uniqueID).toEqual(
      "SIGNALK-60ba2ee8-04ee-45e4-b723-d54ee031ea47",
    );
    expect(metadata.properties.platform.IDNumber).toBeUndefined();
    expect(metadata.properties.platform.IDType).toBeUndefined();
    expect(metadata.properties.platform.name).toBeUndefined();
    expect(metadata.properties.platform.type).toBeUndefined();
  });
});

describe("createGeoJSON", () => {
  test("validates against CSB schema", async () => {
    const json = JSON.parse(
      await text(createGeoJSON(config, vessel, Readable.from(data))),
    );

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(json);

    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});
