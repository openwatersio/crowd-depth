import { afterEach, expect, test } from "vitest";
import nock from "nock";
import { Temporal } from "@js-temporal/polyfill";
import { createHistorySource } from "../../src/sources/history.js";
import { app, config } from "../helper.js";
import { Timeframe } from "../../src/types.js";

afterEach(() => {
  nock.cleanAll();
});

const from = Temporal.Instant.from("2025-01-01T00:00:00.000Z");
const to = Temporal.Instant.from("2025-01-02T00:00:00.000Z");

type Series = {
  // Omitted for v1-style HTTP responses that carry no column metadata.
  values?: { path: string; method: string; $source?: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: [string, ...any[]][];
};

// An app whose built-in history provider answers with the given combined
// response and records the pathSpecs of each call for assertions.
function providerApp(response: Series) {
  const calls: { path: string; sourceRef?: string }[][] = [];
  const history = {
    getPaths: async () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getValues: async (query: any) => {
      calls.push(query.pathSpecs);
      return { context: "vessels.self", range: { from, to }, ...response };
    },
  };
  const testApp = {
    ...app,
    getSelfPath: () => undefined,
    getHistoryApi: async () => history,
  } as unknown as typeof app;
  return { app: testApp, calls };
}

test("pairs position, depth and heading, dropping rows without a position or depth", async () => {
  const { app: testApp } = providerApp({
    values: [
      { path: "navigation.position", method: "first" },
      { path: "environment.depth.depthFromTransducer", method: "min" },
      { path: "navigation.headingTrue", method: "average" },
    ],
    data: [
      ["2025-01-01T12:00:00.000Z", [1, 2], 3.2, 90],
      ["2025-01-01T12:00:01.000Z", [null, null], 6.7, 45], // no position → skip
      ["2025-01-01T12:00:02.000Z", [3, 4], null, 45], // no depth → skip
      ["2025-01-01T12:00:03.000Z", [5, 6], 9.9, null], // no heading → kept, heading undefined
    ],
  });

  const source = await createHistorySource(testApp, config);
  const reader = await source?.createReader(new Timeframe(from, to));

  expect(reader).toBeDefined();
  expect(await reader!.toArray()).toEqual([
    {
      timestamp: Temporal.Instant.from("2025-01-01T12:00:00.000Z"),
      longitude: 1,
      latitude: 2,
      depth: 3.2,
      heading: 90,
    },
    {
      timestamp: Temporal.Instant.from("2025-01-01T12:00:03.000Z"),
      longitude: 5,
      latitude: 6,
      depth: 9.9,
      heading: undefined,
    },
  ]);
});

test("leaves the bucket stamped at the end of the window for the next report", async () => {
  const { app: testApp } = providerApp({
    values: [
      { path: "navigation.position", method: "first" },
      { path: "environment.depth.depthFromTransducer", method: "min" },
    ],
    data: [
      ["2025-01-01T23:59:59.000Z", [1, 2], 3.2],
      [to.toString(), [3, 4], 5.6],
    ],
  });

  const source = await createHistorySource(testApp, config);
  const reader = await source?.createReader(new Timeframe(from, to));

  expect((await reader!.toArray()).map((d) => d.timestamp)).toEqual([
    Temporal.Instant.from("2025-01-01T23:59:59.000Z"),
  ]);
});

// Regression: the provider may return columns in a different order than
// requested, so columns must be mapped by path, not by position.
test("maps columns by path when the provider reorders them", async () => {
  const { app: testApp } = providerApp({
    values: [
      { path: "environment.depth.depthFromTransducer", method: "min" },
      { path: "navigation.headingTrue", method: "average" },
      { path: "navigation.position", method: "first" },
    ],
    data: [["2025-01-01T12:00:00.000Z", 3.2, 90, [1, 2]]],
  });

  const source = await createHistorySource(testApp, config);
  const reader = await source?.createReader(new Timeframe(from, to));

  expect(await reader!.toArray()).toEqual([
    {
      timestamp: Temporal.Instant.from("2025-01-01T12:00:00.000Z"),
      longitude: 1,
      latitude: 2,
      depth: 3.2,
      heading: 90,
    },
  ]);
});

// Regression: v1-style HTTP history responses carry no `values` metadata, so
// columns fall back to the requested path order (position, depth, heading).
test("falls back to requested column order when the response omits values", async () => {
  const { app: testApp } = providerApp({
    data: [["2025-01-01T12:00:00.000Z", [1, 2], 3.2, 90]],
  });

  const source = await createHistorySource(testApp, config);
  const reader = await source?.createReader(new Timeframe(from, to));

  expect(await reader!.toArray()).toEqual([
    {
      timestamp: Temporal.Instant.from("2025-01-01T12:00:00.000Z"),
      longitude: 1,
      latitude: 2,
      depth: 3.2,
      heading: 90,
    },
  ]);
});

test("pins position and depth to the configured sources", async () => {
  const { app: testApp, calls } = providerApp({
    values: [
      { path: "navigation.position", method: "first" },
      { path: "environment.depth.depthFromTransducer", method: "min" },
      { path: "navigation.headingTrue", method: "average" },
    ],
    data: [["2025-01-01T12:00:00.000Z", [1, 2], 3.2, 90]],
  });

  const source = await createHistorySource(testApp, {
    ...config,
    gnss: { ...config.gnss, source: "GPS1" },
    sounder: { ...config.sounder, source: "Sounder1" },
  });
  await (await source?.createReader(new Timeframe(from, to)))?.toArray();

  const specs = calls[0];
  expect(specs.find((s) => s.path === "navigation.position")?.sourceRef).toBe(
    "GPS1",
  );
  expect(
    specs.find((s) => s.path.startsWith("environment.depth"))?.sourceRef,
  ).toBe("Sounder1");
});

test("lists available history dates", async () => {
  const host = "http://history.test";
  const listFrom = Temporal.Instant.from("2025-01-01T00:00:00.000Z");
  const listTo = Temporal.Instant.from("2025-01-05T00:00:00.000Z");

  nock(host)
    .get("/signalk/v1/history/contexts")
    .query(true)
    .reply(200, { data: [] });

  nock(host)
    .get("/signalk/v1/history/values")
    .query((query) => query.resolution === "86400")
    .reply(200, {
      data: [
        ["2025-01-01T00:00:00.000Z", 1],
        ["2025-01-02T00:00:00.000Z", null],
        ["2025-01-03T00:00:00.000Z", 2],
        ["2025-01-04T00:00:00.000Z", 0],
      ],
    });

  const source = await createHistorySource(app, config, { host: `${host}/` });
  const dates = await source!.getAvailableTimeframes(
    new Timeframe(listFrom, listTo),
    Temporal.Duration.from({ hours: 24 }),
  );

  expect(dates).toHaveLength(3);
  expect(dates![0].from).toEqual(
    Temporal.Instant.from("2025-01-01T00:00:00.000Z"),
  );
  expect(dates![2].from).toEqual(
    Temporal.Instant.from("2025-01-04T00:00:00.000Z"),
  );
});

// Regression: the live stream adds the transducer depth before storing, but a
// history provider stores the depth as received, so the reader must add it too
// or a depth below the transducer is reported as one below the waterline.
test("measures depths from the waterline like the live stream", async () => {
  const { app: testApp } = providerApp({
    values: [
      { path: "navigation.position", method: "first" },
      { path: "environment.depth.belowTransducer", method: "min" },
    ],
    data: [["2025-01-01T12:00:00.000Z", [1, 2], 3.2]],
  });

  const source = await createHistorySource(testApp, {
    ...config,
    path: "belowTransducer",
    sounder: { x: 0, y: 0, z: 0.5 },
  });
  const reader = await source?.createReader(new Timeframe(from, to));
  const [point] = await reader!.toArray();

  expect(point.depth).toBeCloseTo(3.7, 6);
});

test("orients soundings by course over ground when no heading was recorded", async () => {
  const { app: testApp } = providerApp({
    values: [
      { path: "navigation.position", method: "first" },
      { path: "environment.depth.depthFromTransducer", method: "min" },
      { path: "navigation.courseOverGroundTrue", method: "min" },
      { path: "navigation.speedOverGround", method: "min" },
    ],
    data: [
      ["2025-01-01T12:00:00.000Z", [1, 2], 3.2, 1.5, 3],
      ["2025-01-01T12:00:01.000Z", [1, 2], 3.3, 1.5, 0.2], // nearly stopped
    ],
  });

  const source = await createHistorySource(testApp, config);
  const points = await (await source!.createReader(
    new Timeframe(from, to),
  ))!.toArray();

  expect(points.map((p) => p.heading)).toEqual([1.5, undefined]);
});

// Regression: a provider that throws on an unrecorded path must not cost the
// orientation paths it does have, or every sounding would be dropped.
test("retries with the orientation paths the provider has recorded", async () => {
  const calls: string[][] = [];
  const history = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getValues: async ({ pathSpecs }: any) => {
      const paths = pathSpecs.map((s: { path: string }) => s.path);
      calls.push(paths);
      if (paths.includes("navigation.headingTrue")) throw new Error("no path");
      return {
        context: "vessels.self",
        range: { from, to },
        data: [["2025-01-01T12:00:00.000Z", [1, 2], 3.2, 1.5, 3]],
      };
    },
    getPaths: async () => [
      "navigation.position",
      "environment.depth.depthFromTransducer",
      "navigation.courseOverGroundTrue",
      "navigation.speedOverGround",
    ],
  };
  const testApp = {
    ...app,
    getSelfPath: () => undefined,
    getHistoryApi: async () => history,
  } as unknown as typeof app;

  const source = await createHistorySource(testApp, config);
  const points = await (await source!.createReader(
    new Timeframe(from, to),
  ))!.toArray();

  expect(calls[1]).toEqual([
    "navigation.position",
    "environment.depth.depthFromTransducer",
    "navigation.courseOverGroundTrue",
    "navigation.speedOverGround",
  ]);
  expect(points[0].heading).toBe(1.5);
});

test("historical GNSS quality matches source and bucket, with no present-day fallback", async () => {
  const time = "2025-01-01T12:00:00Z";
  const testApp = {
    ...app,
    getSelfPath: () => undefined,
    getHistoryApi: async () => ({
      getPaths: async () => [
        "navigation.gnss.satellites",
        "navigation.gnss.methodQuality",
      ],
      getValues: async (req: { pathSpecs: { path: string }[] }) =>
        req.pathSpecs[0].path.startsWith("navigation.gnss")
          ? {
              values: [
                { path: "navigation.gnss.satellites", $source: "gps" },
                { path: "navigation.gnss.methodQuality", $source: "other" },
              ],
              data: [[time, 12, "RTK fixed integer"]],
            }
          : {
              values: [
                { path: "navigation.position" },
                { path: "environment.depth.belowTransducer" },
              ],
              data: [
                [time, [1, 2], 3],
                ["2025-01-01T12:00:01Z", [1, 2], 4],
              ],
            },
    }),
  } as unknown as typeof app;
  const source = await createHistorySource(testApp, {
    ...config,
    path: "belowTransducer",
    gnss: { ...config.gnss, source: "gps" },
  });
  const rows = await (await source!.createReader(
    new Timeframe(from, to),
  ))!.toArray();
  expect(rows[0].gnss).toEqual({ satellites: 12 });
  expect(rows[1].gnss).toBeUndefined();
});

test("spatial preview hints query only own tracks and return clamped unique hours", async () => {
  const { app: testApp } = providerApp({ data: [] });
  const requests: unknown[] = [];
  Object.assign(testApp, {
    selfId: "urn:mrn:imo:mmsi:123",
    getTrackApi: async () => ({
      getTracks: async (query: unknown) => {
        requests.push(query);
        return {
          features: [
            {
              properties: {
                context: "vessels.urn:mrn:imo:mmsi:123",
                coordTimes: [
                  [
                    "2025-01-01T12:05:00Z",
                    "2025-01-01T12:45:00Z",
                    "2025-01-01T13:00:00Z",
                    "invalid",
                  ],
                ],
              },
            },
            {
              properties: {
                context: "vessels.other",
                coordTimes: [["2025-01-01T16:00:00Z"]],
              },
            },
          ],
        };
      },
    }),
  });
  const source = await createHistorySource(testApp, config);
  const windows = await source!.getPreviewTimeframes!(
    new Timeframe(from, to),
    [-81, 25, -79, 27],
  );
  expect(windows.map((w) => w.from.toString())).toEqual([
    "2025-01-01T13:00:00Z",
    "2025-01-01T12:00:00Z",
  ]);
  expect(requests[0]).toMatchObject({
    contexts: ["vessels.urn:mrn:imo:mmsi:123"],
    bbox: [-81, 25, -79, 27],
    times: true,
    clip: true,
  });
});

test("preview reader skips optional GNSS metadata while preserving paired depth and position", async () => {
  const { app: testApp } = providerApp({
    data: [["2025-01-01T12:00:00Z", [1, 2], 3.2, null, null, null]],
  });
  let paths = 0;
  const api = await testApp.getHistoryApi!();
  api.getPaths = async () => {
    paths++;
    return [];
  };
  const source = await createHistorySource(testApp, {
    ...config,
    gnss: { ...config.gnss, source: "gps" },
  });
  const reader = await source!.createPreviewReader!(new Timeframe(from, to));
  expect((await reader!.toArray())[0]).toMatchObject({
    longitude: 1,
    latitude: 2,
    depth: 3.2,
  });
  expect(paths).toBe(0);
  await source!.createReader(new Timeframe(from, to));
  expect(paths).toBe(1);
});

test("availability uses the same selected sounder as detailed history reads", async () => {
  const { app: testApp, calls } = providerApp({ values: [], data: [] });
  const source = await createHistorySource(testApp, {
    ...config,
    sounder: { ...config.sounder, source: "chosen" },
  });
  await source!.getAvailableTimeframes(
    new Timeframe(from, to),
    Temporal.Duration.from({ hours: 1 }),
  );
  expect(calls[0][0].sourceRef).toBe("chosen");
});

test("preferred history does not pin today's live source onto old recordings", async () => {
  const { app: testApp, calls } = providerApp({ data: [] });
  testApp.getSelfPath = () => ({ $source: "current.receiver" });
  const source = await createHistorySource(testApp, {
    ...config,
    gnss: { ...config.gnss, source: "" },
    sounder: { ...config.sounder, source: "" },
  });
  await source!.createReader(new Timeframe(from, to));
  expect(calls[0].every((spec) => spec.sourceRef === undefined)).toBe(true);
});

test("explicit selection does not silently use unfiltered legacy HTTP history", async () => {
  nock("http://legacy.test")
    .get("/signalk/v1/history/contexts")
    .query(true)
    .reply(200, { data: [] });
  const source = await createHistorySource(
    app,
    { ...config, sounder: { ...config.sounder, source: "chosen" } },
    { host: "http://legacy.test/" },
  );
  expect(source).toBeDefined();
  await expect(source!.createReader(new Timeframe(from, to))).rejects.toThrow(
    "Legacy HTTP history cannot filter sensor sources",
  );
  await expect(
    source!.getAvailableTimeframes(
      new Timeframe(from, to),
      Temporal.Duration.from({ hours: 1 }),
    ),
  ).rejects.toThrow("Legacy HTTP history cannot filter sensor sources");
});

test("archive reader preserves uncorrected history aggregates and actual column sources", async () => {
  const { app: testApp } = providerApp({
    values: [
      { path: "navigation.position", method: "first", $source: "gps.actual" },
      {
        path: "environment.depth.belowTransducer",
        method: "min",
        $source: "depth.actual",
      },
      { path: "navigation.courseOverGroundTrue", method: "min" },
      { path: "navigation.speedOverGround", method: "min" },
    ],
    data: [
      ["2025-01-01T12:00:00.123456789Z", [1.123456789, 2], 3.123456789, 1.5, 2],
    ],
  });
  const source = await createHistorySource(testApp, {
    ...config,
    path: "belowTransducer",
    sounder: { ...config.sounder, z: 2 },
  });
  const reader = await source!.createObservationReader!(
    new Timeframe(from, to),
  );
  expect(await reader!.toArray()).toEqual([
    {
      timestamp: "2025-01-01T12:00:00.123456789Z",
      longitude: 1.123456789,
      latitude: 2,
      depth: 3.123456789,
      depthSource: "depth.actual",
      positionSource: "gps.actual",
      headingTrue: undefined,
      courseOverGroundTrue: 1.5,
      speedOverGround: 2,
      gnss: undefined,
    },
  ]);
});
test("archive reader does not invent source IDs from requested settings", async () => {
  const { app: testApp } = providerApp({
    data: [["2025-01-01T12:00:00Z", [1, 2], 3]],
  });
  const source = await createHistorySource(testApp, {
    ...config,
    sounder: { ...config.sounder, source: "requested.depth" },
    gnss: { ...config.gnss, source: "requested.gps" },
  });
  const points = await (await source!.createObservationReader!(
    new Timeframe(from, to),
  ))!.toArray();
  expect(points[0].depthSource).toBeUndefined();
  expect(points[0].positionSource).toBeUndefined();
});

test("returns usable original observations marked incomplete when optional GNSS lookup fails", async () => {
  const { app: testApp } = providerApp({
    data: [["2025-01-01T12:00:00Z", [1, 2], 3]],
  });
  const api = await testApp.getHistoryApi!();
  api.getPaths = async () => {
    throw Error("quality backend unavailable");
  };
  const source = await createHistorySource(testApp, {
    ...config,
    gnss: { ...config.gnss, source: "gps" },
  });
  const reader = await source!.createObservationReader!(
    new Timeframe(from, to),
  );
  expect(reader).toHaveProperty("metadataIncomplete", true);
  expect((await reader!.toArray())[0]).toMatchObject({
    depth: 3,
    metadataIncomplete: true,
  });
  // Reporting's optional metadata policy remains independent of durable archive replacement.
  expect(await source!.createReader(new Timeframe(from, to))).toBeDefined();
});

test("a failed orientation discovery does not prevent reading available core observations", async () => {
  const { app: testApp } = providerApp({ data: [] });
  const api = await testApp.getHistoryApi!();
  let reads = 0;
  api.getValues = async () => {
    reads++;
    if (reads === 1) throw Error("optional paths unavailable");
    return {
      context: "vessels.self",
      range: { from, to },
      data: [["2025-01-01T12:00:00Z", [1, 2], 3]],
    };
  };
  api.getPaths = async () => {
    throw Error("paths unavailable");
  };
  const source = await createHistorySource(testApp, config);
  const reader = await source!.createObservationReader!(
    new Timeframe(from, to),
  );
  expect((await reader!.toArray())[0]).toMatchObject({
    depth: 3,
    metadataIncomplete: true,
  });
  expect(reads).toBe(2);
});

test("does not replace archived quality with source-unaware metadata", async () => {
  const { app: testApp } = providerApp({
    values: [{ path: "navigation.gnss.satellites", method: "first" }],
    data: [["2025-01-01T12:00:00Z", 12]],
  });
  const api = await testApp.getHistoryApi!();
  api.getPaths = async () => ["navigation.gnss.satellites"];
  const source = await createHistorySource(testApp, {
    ...config,
    gnss: { ...config.gnss, source: "gps" },
  });
  const reader = await source!.createObservationReader!(
    new Timeframe(from, to),
  );
  expect(reader).toHaveProperty("metadataIncomplete", true);
});
