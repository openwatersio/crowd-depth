import { expect, test } from "vitest";
import { createSqliteSource } from "../../src/sources/sqlite.js";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { app } from "../helper.js";
import { createDB } from "../../src/storage.js";
import { Temporal } from "@js-temporal/polyfill";
import { Timeframe } from "../../src/types.js";

const data = [
  {
    latitude: 1,
    longitude: 2,
    depth: 3,
    timestamp: Temporal.Instant.from("2025-08-06T22:00:00.000Z"),
    heading: 0,
  },
  // without heading
  {
    latitude: 4,
    longitude: 5,
    depth: 6,
    timestamp: Temporal.Instant.from("2025-08-06T23:00:00.000Z"),
  },
  // undefined heading
  {
    latitude: 4,
    longitude: 5,
    depth: 6,
    timestamp: Temporal.Instant.from("2025-08-07T00:00:00.000Z"),
    heading: undefined,
  },
];

test("reading and writing to sqlite", async () => {
  const source = createSqliteSource(app, createDB(":memory:"));
  const writer = source.createWriter!();
  await pipeline(Readable.from(data), writer);

  const reader = await source.createReader(
    new Timeframe(
      Temporal.Instant.fromEpochMilliseconds(0),
      Temporal.Now.instant(),
    ),
  );
  const result = await reader!.toArray();
  expect(result.length).toBe(data.length);
  expect(result[0]).toEqual(data[0]);
  expect(result[1]).toEqual({ ...data[1], heading: null });
  expect(result[2]).toEqual({ ...data[2], heading: null });
});

test("reading with from and to", async () => {
  const source = createSqliteSource(app, createDB(":memory:"));
  const writer = source.createWriter!();
  await pipeline(Readable.from(data), writer);

  const reader = await source.createReader(
    new Timeframe(
      Temporal.Instant.from("2025-08-06T22:30:00.000Z"),
      Temporal.Instant.from("2025-08-06T23:30:00.000Z"),
    ),
  );

  const result = await reader!.toArray();
  expect(result.length).toBe(1);
  expect(result[0].timestamp).toEqual(data[1].timestamp);
});

test("reading with no data", async () => {
  const source = createSqliteSource(app, createDB(":memory:"));

  const reader = await source.createReader(
    new Timeframe(
      Temporal.Instant.from("2025-08-06T22:30:00.000Z"),
      Temporal.Instant.from("2025-08-06T23:30:00.000Z"),
    ),
  );

  expect(reader).toBeUndefined();
});

function point(
  ts: string,
  extra: Partial<{
    latitude: number;
    longitude: number;
    depth: number;
    heading: number | undefined;
  }> = {},
) {
  return {
    latitude: 1,
    longitude: 2,
    depth: 3,
    timestamp: Temporal.Instant.from(ts),
    ...extra,
  };
}

test("getAvailableTimeframes returns 6-hour windows with data", async () => {
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  const writer = source.createWriter!();

  const data = [
    point("2025-01-01T01:00:00Z"), // bucket [00:00, 06:00)
    point("2025-01-01T07:30:00Z"), // bucket [06:00, 12:00)
    point("2025-01-02T00:30:00Z"), // bucket [00:00, 06:00) next day
  ];

  await pipeline(Readable.from(data), writer);

  const from = Temporal.Instant.from("2025-01-01T00:00:00Z");
  const to = Temporal.Instant.from("2025-01-03T00:00:00Z");
  const windowSize = Temporal.Duration.from({ hours: 6 });

  const windows = await source.getAvailableTimeframes!(
    new Timeframe(from, to),
    windowSize,
  );
  expect(windows).toHaveLength(3);

  expect(windows[0].from).toEqual(
    Temporal.Instant.from("2025-01-01T00:00:00Z"),
  );
  expect(windows[0].to).toEqual(Temporal.Instant.from("2025-01-01T06:00:00Z"));

  expect(windows[1].from).toEqual(
    Temporal.Instant.from("2025-01-01T06:00:00Z"),
  );
  expect(windows[1].to).toEqual(Temporal.Instant.from("2025-01-01T12:00:00Z"));

  expect(windows[2].from).toEqual(
    Temporal.Instant.from("2025-01-02T00:00:00Z"),
  );
  expect(windows[2].to).toEqual(Temporal.Instant.from("2025-01-02T06:00:00Z"));
});

test("getAvailableTimeframes returns empty for no data", async () => {
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);

  const from = Temporal.Instant.from("2025-01-01T00:00:00Z");
  const to = Temporal.Instant.from("2025-01-02T00:00:00Z");
  const windowSize = Temporal.Duration.from({ hours: 6 });

  const windows = await source.getAvailableTimeframes!(
    new Timeframe(from, to),
    windowSize,
  );
  expect(windows).toHaveLength(0);
});
