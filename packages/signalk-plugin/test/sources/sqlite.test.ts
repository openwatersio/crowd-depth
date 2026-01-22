import { expect, test } from "vitest";
import { createSqliteSource } from "../../src/sources/sqlite.js";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { app } from "../helper.js";
import { createDB } from "../../src/storage.js";
import { Temporal } from "@js-temporal/polyfill";

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

  const reader = await source.createReader({
    from: Temporal.Instant.fromEpochMilliseconds(0),
    to: Temporal.Now.instant(),
  });
  const result = await reader.toArray();
  expect(result.length).toBe(data.length);
  expect(result[0]).toEqual(data[0]);
  expect(result[1]).toEqual({ ...data[1], heading: null });
  expect(result[2]).toEqual({ ...data[2], heading: null });
});

test("reading with from and to", async () => {
  const source = createSqliteSource(app, createDB(":memory:"));
  const writer = source.createWriter!();
  await pipeline(Readable.from(data), writer);

  const reader = await source.createReader({
    from: Temporal.Instant.from("2025-08-06T22:30:00.000Z"),
    to: Temporal.Instant.from("2025-08-06T23:30:00.000Z"),
  });

  const result = await reader.toArray();
  expect(result.length).toBe(1);
  expect(result[0].timestamp).toEqual(data[1].timestamp);
});

test("reading with no data", async () => {
  const source = createSqliteSource(app, createDB(":memory:"));

  const reader = await source.createReader({
    from: new Date("2025-08-06T22:30:00.000Z"),
    to: new Date("2025-08-06T23:30:00.000Z"),
  });

  expect(reader).toBeUndefined();
});
