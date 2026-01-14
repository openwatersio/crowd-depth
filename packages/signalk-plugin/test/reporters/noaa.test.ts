import { describe, test, expect } from "vitest";
import {
  getMetadata,
  BathymetryData,
  BATHY_URL,
  submitGeoJSON,
} from "../../src/index.js";
import { Readable } from "stream";
import nock from "nock";
import { config, vessel } from "../helper.js";

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
    timestamp: new Date("2024-01-01T00:00:00Z"),
  },
  {
    longitude: -122.124,
    latitude: 37.124,
    depth: 20,
    timestamp: new Date("2024-01-01T00:01:01Z"),
  },
  {
    longitude: -122.125,
    latitude: 37.125,
    depth: 30,
    timestamp: new Date("2024-01-01T00:02:02Z"),
  },
];

describe("submitGeoJSON", () => {
  test("success", async () => {
    const scope = nock(BATHY_URL)
      .post("/geojson", (body) => {
        expect(body).toHaveProperty("type", "FeatureCollection");
        expect(body).toHaveProperty("features");
        expect(body.features).toHaveLength(data.length);
        expect(body).toHaveProperty("crs");
        expect(body).toHaveProperty("properties");
        expect(body.properties).toHaveProperty("convention", "GeoJSON CSB 3.0");
        expect(body.properties).toHaveProperty("platform");
        expect(body.properties.platform).toHaveProperty(
          "uniqueID",
          "SIGNALK-1234",
        );
        expect(body.properties.platform).toHaveProperty(
          "IDNumber",
          "123456789",
        );
        expect(body.properties.platform).toHaveProperty("IDType", "MMSI");
        expect(body.properties.platform).toHaveProperty("name", "Test Vessel");
        expect(body.properties.platform).toHaveProperty("type", "Sailing");
        return true;
      })
      .reply(200, SUCCESS_RESPONSE);

    await submitGeoJSON(BATHY_URL, config, vessel, Readable.from(data));
    expect(scope.isDone()).toBe(true);
  });
});

describe("getMetadata", () => {
  test("includes platform data", () => {
    const metadata = getMetadata(vessel, config);
    expect(metadata.platform.uniqueID).toEqual("SIGNALK-1234");
    expect(metadata.platform.IDNumber).toEqual("123456789");
    expect(metadata.platform.IDType).toEqual("MMSI");
    expect(metadata.platform.name).toEqual("Test Vessel");
    expect(metadata.platform.type).toEqual("Sailing");
  });

  test("anonymous does not include MMSI, name, etc", () => {
    const metadata = getMetadata(vessel, {
      ...config,
      sharing: {
        ...config.sharing,
        anonymous: true,
      },
    });
    expect(metadata.platform.uniqueID).toEqual("SIGNALK-1234");
    expect(metadata.platform.IDNumber).toBeUndefined();
    expect(metadata.platform.IDType).toBeUndefined();
    expect(metadata.platform.name).toBeUndefined();
    expect(metadata.platform.type).toBeUndefined();
  });
});
