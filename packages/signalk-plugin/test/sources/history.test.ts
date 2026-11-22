import { afterEach, expect, test, vi } from "vitest";
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
  values?: { path: string; method: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: [string, ...any[]][];
};

// An app whose built-in history provider answers with the given combined
// response and records the pathSpecs of each call for assertions.
function providerApp(response: Series) {
  const calls: { path: string; sourceRef?: string }[][] = [];
  const history = {
    getPaths: async () => response.values?.map((value) => value.path) ?? [],
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
      positionOrigin: { x: 1, y: 2 },
      timestamp: Temporal.Instant.from("2025-01-01T12:00:00.000Z"),
      longitude: 1,
      latitude: 2,
      depth: 3.2,
      heading: 90,
    },
    {
      positionOrigin: { x: 1, y: 2 },
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
      positionOrigin: { x: 1, y: 2 },
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
      positionOrigin: { x: 1, y: 2 },
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

test("history quality follows an explicit receiver and omits ambiguous preferred series", async () => {
  const response = {
    values: [
      { path: "navigation.position", method: "first" },
      { path: "environment.depth.depthFromTransducer", method: "min" },
      { path: "navigation.gnss.satellites", method: "first" },
    ],
    data: [["2025-01-01T12:00:00Z", [1, 2], 3.2, 8]],
  } as Series;
  const { app: testApp, calls } = providerApp(response);
  const selected = await createHistorySource(testApp, {
    ...config,
    gnss: { ...config.gnss, source: "gps.one" },
  });
  const selectedRows = await (await selected!.createReader(
    new Timeframe(from, to),
  ))!.toArray();
  expect(selectedRows[0].gnss).toEqual({ satellites: 8 });
  expect(
    calls.some((specs) =>
      specs.some(
        (spec) =>
          spec.path === "navigation.gnss.satellites" &&
          spec.sourceRef === "gps.one",
      ),
    ),
  ).toBe(true);
  const preferred = await createHistorySource(testApp, {
    ...config,
    gnss: { ...config.gnss, source: "" },
  });
  expect(
    (
      await (await preferred!.createReader(new Timeframe(from, to)))!.toArray()
    )[0].gnss,
  ).toBeUndefined();
});

test("unsupported optional quality aggregates do not prevent depth reporting", async () => {
  const response = {
    values: [
      { path: "navigation.position", method: "first" },
      { path: "environment.depth.depthFromTransducer", method: "min" },
    ],
    data: [["2025-01-01T12:00:00Z", [1, 2], 3.2]],
  } as Series;
  const { app: testApp } = providerApp(response);
  const history = await testApp.getHistoryApi();
  const original = history.getValues;
  history.getPaths = async () => ["navigation.gnss.methodQuality"];
  history.getValues = async (query) => {
    if (
      query.pathSpecs.some(
        (spec) => spec.path === "navigation.gnss.methodQuality",
      )
    )
      throw new Error("cannot aggregate strings");
    return original(query);
  };
  const source = await createHistorySource(testApp, config);
  const rows = await (await source!.createReader(
    new Timeframe(from, to),
  ))!.toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0].depth).toBe(3.2);
  expect(rows[0].gnss).toBeUndefined();
});

test("slow optional quality cannot block depth reads or overlap queries", async () => {
  const response = {
    values: [
      { path: "navigation.position", method: "first" },
      { path: "environment.depth.depthFromTransducer", method: "min" },
    ],
    data: [["2025-01-01T12:00:00Z", [1, 2], 3.2]],
  } as Series;
  const { app: testApp } = providerApp(response);
  const history = await testApp.getHistoryApi();
  const original = history.getValues;
  let qualityCalls = 0;
  history.getPaths = async () => ["navigation.gnss.satellites"];
  history.getValues = async (query) => {
    if (
      query.pathSpecs.some((spec) => spec.path === "navigation.gnss.satellites")
    ) {
      qualityCalls++;
      return await new Promise(() => {});
    }
    return original(query);
  };
  const source = await createHistorySource(testApp, config);
  vi.useFakeTimers();
  try {
    const pending = source!.createReader(new Timeframe(from, to));
    await vi.advanceTimersByTimeAsync(2001);
    expect(await (await pending)!.toArray()).toHaveLength(1);
    expect(
      await (await source!.createReader(new Timeframe(from, to)))!.toArray(),
    ).toHaveLength(1);
    expect(qualityCalls).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("chart readers skip optional quality queries", async () => {
  const { app: testApp, calls } = providerApp({
    values: [
      { path: "navigation.position", method: "first" },
      { path: "environment.depth.depthFromTransducer", method: "min" },
      { path: "navigation.gnss.satellites", method: "first" },
    ],
    data: [["2025-01-01T12:00:00Z", [1, 2], 3, 8]],
  });
  const source = await createHistorySource(testApp, config, {
    includeQuality: false,
  });
  await (await source!.createReader(new Timeframe(from, to))).toArray();
  expect(calls).toHaveLength(1);
  expect(
    calls[0].some((spec) => spec.path.startsWith("navigation.gnss.")),
  ).toBe(false);
});
