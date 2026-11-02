import { describe, test, expect, vi } from "vitest";
import Ajv from "ajv/dist/2020.js";
import {
  getMetadata,
  BathymetryData,
  BATHY_URL,
  submitGeoJSON,
  createGeoJSON,
  SubmissionError,
  describeSubmissionError,
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
  test("a stalled GeoJSON stream times out with an actionable error", async () => {
    vi.useFakeTimers();
    const stream = new Readable({ objectMode: true, read() {} });
    try {
      const upload = submitGeoJSON(
        BATHY_URL,
        config,
        vessel,
        stream,
        undefined,
        1000,
      );
      const result = upload.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({
        message:
          "GeoJSON generation timed out; raise BATHY_REPORT_TIMEOUT for slow storage",
      });
      expect(stream.destroyed).toBe(true);
    } finally {
      stream.destroy();
      vi.useRealTimers();
    }
  });

  test("cancels an in-flight HTTP upload when the reporter stops", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          );
          started();
        }),
    );
    try {
      const upload = submitGeoJSON(
        BATHY_URL,
        config,
        vessel,
        Readable.from(data),
        controller.signal,
      );
      const rejected = expect(upload).rejects.toThrow("Stopping upload");
      await sending;
      controller.abort(new Error("Stopping upload"));
      await rejected;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("success", async () => {
    const scope = nock(BATHY_URL)
      .post("/geojson")
      .matchHeader("user-agent", /^crowd-depth/)
      .reply(200, SUCCESS_RESPONSE);
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

  test("gives sensor offsets from the reference point, forward, starboard and down", () => {
    const metadata = getMetadata(vessel, {
      ...config,
      // Transducer 3 m from the bow, 0.5 m to port, 0.4 m below the waterline
      sounder: { x: -0.5, y: 3, z: 0.4 },
      // Antenna 9 m from the bow on the centreline, 2 m above the waterline
      gnss: { x: 0, y: 9, z: 2 },
    });
    const [sounder, gnss] = metadata.properties.platform.sensors;

    expect(metadata.properties.trustedNode.vesselPositionReferencePoint).toBe(
      "Transducer",
    );
    expect(sounder!.position).toEqual([0, 0, 0]);
    // The antenna is 6 m aft of, 0.5 m to starboard of, and 2.4 m above the transducer
    expect(gnss!.position[0]).toBeCloseTo(-6, 6);
    expect(gnss!.position[1]).toBeCloseTo(0.5, 6);
    expect(gnss!.position[2]).toBeCloseTo(-2.4, 6);
  });

  test("reports the waterline when the transducer depth is known", () => {
    const metadata = getMetadata(vessel, {
      ...config,
      path: "belowTransducer",
      sounder: { x: 0, y: 0, z: 0.5 },
    });
    expect(metadata.properties.trustedNode.verticalReferenceOfDepth).toBe(
      "Waterline",
    );
  });

  test("reports the transducer when its depth below the waterline is unknown", () => {
    const metadata = getMetadata(vessel, {
      ...config,
      path: "belowTransducer",
      sounder: { x: 0, y: 0 },
    });
    expect(metadata.properties.trustedNode.verticalReferenceOfDepth).toBe(
      "Transducer",
    );
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

describe("describeSubmissionError", () => {
  test("surfaces server message and submission id", () => {
    const err = new SubmissionError(
      "POST to https://depth.openwaters.io/geojson failed: 502 Bad Gateway",
      502,
      JSON.stringify({
        success: false,
        message: "POST to NOAA failed: 500 Internal Server Error",
        submissionId: "2026/07/29/07:11:13.123Z-abc",
      }),
    );

    expect(describeSubmissionError(err)).toBe(
      "POST to NOAA failed: 500 Internal Server Error (submission: 2026/07/29/07:11:13.123Z-abc)",
    );
  });

  test("surfaces server message without submission id", () => {
    const err = new SubmissionError("failed", 500, '{"message":"boom"}');
    expect(describeSubmissionError(err)).toBe("boom");
  });

  test("falls back to error message for non-JSON bodies", () => {
    const err = new SubmissionError(
      "POST failed: 503",
      503,
      "<html>oops</html>",
    );
    expect(describeSubmissionError(err)).toBe("POST failed: 503");
  });

  test("falls back to error message for plain errors", () => {
    expect(describeSubmissionError(new Error("fetch failed"))).toBe(
      "fetch failed",
    );
    expect(describeSubmissionError("boom")).toBe("boom");
    expect(describeSubmissionError(undefined)).toBe("undefined");
  });
});
