import { describe, expect, test } from "vitest";
import { fromXyz, toXyz } from "../../src/streams/xyz.js";
import { Readable } from "stream";
import { text } from "stream/consumers";
import { Temporal } from "@js-temporal/polyfill";

describe("toXyz", () => {
  const data = [
    {
      latitude: 1,
      longitude: 2,
      depth: 3,
      timestamp: Temporal.Instant.from("2025-08-06T22:00:00.000Z"),
    },
    {
      latitude: 4,
      longitude: 5,
      depth: 6,
      timestamp: Temporal.Instant.from("2025-08-06T23:00:00.000Z"),
      heading: 1.4,
    },
  ];

  test("converts data", async () => {
    const result = await text(Readable.from(data).compose(toXyz()));
    expect(result).toEqual(
      [
        "LON,LAT,DEPTH,TIME,HEAD\n",
        "2,1,3,2025-08-06T22:00:00.000Z,\n",
        "5,4,6,2025-08-06T23:00:00.000Z,1.4\n",
      ].join(""),
    );
  });

  test("without heading", async () => {
    const result = await text(
      Readable.from(data).compose(toXyz({ includeHeading: false })),
    );
    expect(result).toEqual(
      [
        "LON,LAT,DEPTH,TIME\n",
        "2,1,3,2025-08-06T22:00:00.000Z\n",
        "5,4,6,2025-08-06T23:00:00.000Z\n",
      ].join(""),
    );
  });
});

describe("FromXyz", () => {
  test("converts data", async () => {
    const data = [
      "LAT,LON,DEPTH,TIME,HEAD",
      "1,2,3,2025-08-06T22:00:00.000Z,2",
      "4,5,6,2025-08-06T23:00:00.000Z,",
    ].join("\n");
    const result = await Readable.from(data).compose(fromXyz()).toArray();
    expect(result).toEqual([
      {
        latitude: 1,
        longitude: 2,
        depth: 3,
        timestamp: Temporal.Instant.from("2025-08-06T22:00:00.000Z"),
        heading: 2,
      },
      {
        latitude: 4,
        longitude: 5,
        depth: 6,
        timestamp: Temporal.Instant.from("2025-08-06T23:00:00.000Z"),
        heading: undefined,
      },
    ]);
  });

  test("handles fields in different order", async () => {
    const data = ["LON,LAT,DEPTH,TIME", "1,2,3,2025-08-06T22:00:00.000Z"].join(
      "\n",
    );
    const result = await Readable.from(data).compose(fromXyz()).toArray();
    expect(result).toEqual([
      {
        longitude: 1,
        latitude: 2,
        depth: 3,
        timestamp: Temporal.Instant.from("2025-08-06T22:00:00.000Z"),
      },
    ]);
  });
});
