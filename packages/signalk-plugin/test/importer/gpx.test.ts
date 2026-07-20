import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, test } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { convertGpx, parseRaymarineGpx } from "../../src/index.js";

const fixture = join(import.meta.dirname, "..", "fixtures", "raymarine.gpx");

describe("Raymarine GPX importer", () => {
  test("parses depth and counts points without depth", async () => {
    const parsed = parseRaymarineGpx(await readFile(fixture, "utf8"));
    expect(parsed.trackpoints).toBe(3);
    expect(parsed.pointsWithoutDepth).toBe(1);
    expect(parsed.points.map(({ depth }) => depth)).toEqual([2.5, 3.25]);
  });

  test("requires a time source when GPX timestamps are absent", async () => {
    const parsed = parseRaymarineGpx(await readFile(fixture, "utf8"));
    expect(() =>
      convertGpx(parsed, { depthReference: "belowWaterline" }),
    ).toThrow(/provide both --started-at and --interval/);
  });

  test("creates synthetic timestamps without changing waterline depths", async () => {
    const parsed = parseRaymarineGpx(await readFile(fixture, "utf8"));
    const result = convertGpx(parsed, {
      depthReference: "belowWaterline",
      startedAt: Temporal.Instant.from("2025-07-12T06:30:00Z"),
      interval: Temporal.Duration.from({ seconds: 1 }),
    });
    expect(result.timestampSource).toBe("cli");
    expect(result.data.map(({ timestamp }) => timestamp.toString())).toEqual([
      "2025-07-12T06:30:00Z",
      "2025-07-12T06:30:01Z",
    ]);
    expect(result.data[0].depth).toBe(2.5);
  });

  test("finds WaterDepth with a different namespace prefix", () => {
    const parsed = parseRaymarineGpx(`
      <gpx xmlns:rm="urn:raymarine"><trk><trkseg>
        <trkpt lat="1" lon="2"><time>2025-01-01T00:00:00Z</time><extensions><rm:WaterDepth>4.2</rm:WaterDepth></extensions></trkpt>
      </trkseg></trk></gpx>`);
    expect(parsed.points[0].depth).toBe(4.2);
    expect(parsed.points[0].timestamp?.toString()).toBe("2025-01-01T00:00:00Z");
  });

  test("converts transducer-referenced depth to waterline", async () => {
    const parsed = parseRaymarineGpx(await readFile(fixture, "utf8"));
    const result = convertGpx(parsed, {
      depthReference: "belowTransducer",
      transducerDepth: 0.6,
      startedAt: Temporal.Instant.from("2025-01-01T00:00:00Z"),
      interval: Temporal.Duration.from({ seconds: 1 }),
    });
    expect(result.data[0].depth).toBe(3.1);
  });
});
