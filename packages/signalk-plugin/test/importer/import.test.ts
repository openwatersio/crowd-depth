import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "vitest";
import { parseArgs, runImport } from "../../src/importer/index.js";

const fixture = join(import.meta.dirname, "..", "fixtures", "raymarine.gpx");

describe("import preview", () => {
  test("defaults to no upload and writes GeoJSON", async () => {
    const out = join(
      await mkdtemp(join(tmpdir(), "crowd-depth-")),
      "preview.geojson",
    );
    const options = parseArgs([
      fixture,
      "--depth-reference",
      "belowWaterline",
      "--started-at",
      "2025-07-12T08:30:00+02:00",
      "--interval",
      "1s",
      "--out",
      out,
    ]);
    expect(options.upload).toBe(false);
    const { summary } = await runImport(options);
    const geojson = JSON.parse(await readFile(out, "utf8"));
    expect(summary).toMatchObject({
      trackpoints: 3,
      pointsWithoutDepth: 1,
      importedPoints: 2,
      timestampSource: "cli",
    });
    expect(geojson.features[0]).toMatchObject({
      geometry: { coordinates: [10.2, 54.1] },
      properties: { depth: 2.5, time: "2025-07-12T06:30:00.000Z" },
    });
  });
});
