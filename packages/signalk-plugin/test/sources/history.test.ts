import { afterEach, expect, test } from "vitest";
import nock from "nock";
import { Temporal } from "@js-temporal/polyfill";
import { createHistorySource } from "../../src/sources/history.js";
import { app, config } from "../helper.js";
import { Timeframe } from "../../src/types.js";

afterEach(() => {
  nock.cleanAll();
});

test("reads bathymetry from history http api", async () => {
  const host = "http://history.test";
  const from = Temporal.Instant.from("2025-01-01T00:00:00.000Z");
  const to = Temporal.Instant.from("2025-01-02T00:00:00.000Z");

  nock(host)
    .get("/signalk/v1/history/contexts")
    .query(true)
    .reply(200, { data: [] });

  nock(host)
    .get("/signalk/v1/history/values")
    .query((query) => {
      return (
        typeof query.paths === "string" &&
        query.paths.includes("navigation.position:first") &&
        query.paths.includes("environment.depth.depthFromTransducer:min") &&
        query.paths.includes("navigation.headingTrue:average")
      );
    })
    .reply(200, {
      data: [
        ["2025-01-01T12:00:00.000Z", [1, 2], 3.2, 90],
        ["2025-01-01T13:00:00.000Z", [4, 5], 6.7, null],
        ["2025-01-01T14:00:00.000Z", [6, 7], null, 45],
        ["2025-01-01T14:00:00.000Z", null, 2.2, null],
      ],
    });

  const source = await createHistorySource(app, config, { host: `${host}/` });
  const reader = await source?.createReader(new Timeframe(from, to));

  expect(reader).toBeDefined();
  const results = await reader!.toArray();

  expect(results).toEqual([
    {
      timestamp: Temporal.Instant.from("2025-01-01T12:00:00.000Z"),
      longitude: 1,
      latitude: 2,
      depth: 3.2,
      heading: 90,
    },
    {
      timestamp: Temporal.Instant.from("2025-01-01T13:00:00.000Z"),
      longitude: 4,
      latitude: 5,
      depth: 6.7,
      heading: null,
    },
  ]);
  expect(nock.isDone()).toBe(true);
});

test("lists available history dates", async () => {
  const host = "http://history.test";
  const from = Temporal.Instant.from("2025-01-01T00:00:00.000Z");
  const to = Temporal.Instant.from("2025-01-05T00:00:00.000Z");

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
    new Timeframe(from, to),
    Temporal.Duration.from({ hours: 24 }),
  );

  expect(dates).toBeDefined();
  expect(dates).toHaveLength(3);
  expect(dates![0].from).toEqual(
    Temporal.Instant.from("2025-01-01T00:00:00.000Z"),
  );
  expect(dates![0].to).toEqual(
    Temporal.Instant.from("2025-01-02T00:00:00.000Z"),
  );
  expect(dates![1].from).toEqual(
    Temporal.Instant.from("2025-01-03T00:00:00.000Z"),
  );
  expect(dates![1].to).toEqual(
    Temporal.Instant.from("2025-01-04T00:00:00.000Z"),
  );
  expect(dates![2].from).toEqual(
    Temporal.Instant.from("2025-01-04T00:00:00.000Z"),
  );
  expect(dates![2].to).toEqual(
    Temporal.Instant.from("2025-01-05T00:00:00.000Z"),
  );
});
