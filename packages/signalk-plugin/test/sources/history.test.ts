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
  values?: { path: string; method: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: [string, ...any[]][];
};

// An app whose built-in history provider answers with the given combined
// response and records the pathSpecs of each call for assertions.
function providerApp(response: Series) {
  const calls: { path: string; sourceRef?: string }[][] = [];
  const history = {
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
