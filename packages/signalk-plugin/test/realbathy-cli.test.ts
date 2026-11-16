import { describe, expect, test } from "vitest";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import { text } from "stream/consumers";
import { realbathyToXyz } from "../src/realbathy-cli.js";
import { trl } from "./helper.js";

describe("realbathyToXyz", () => {
  test("writes the track as XYZ", async () => {
    const dir = await mkdtemp(join(tmpdir(), "realbathy-"));
    const file = join(dir, "1.trl");
    await writeFile(
      file,
      trl([
        { lat: -17.7648, lon: 177.18474, depthCm: 1156, seconds: 340509479 },
      ]),
    );
    const output = new PassThrough();
    const result = text(output);
    await realbathyToXyz(file, { utcOffset: -4 }, output);
    expect(await result).toEqual(
      "LON,LAT,DEPTH,TIME\n177.18474,-17.7648,11.56,2026-10-16T05:57:59.000Z\n",
    );
  });
});

const bin = new URL("../bin/realbathy-to-xyz", import.meta.url).pathname;
const built = existsSync(
  new URL("../dist/realbathy-cli.js", import.meta.url).pathname,
);

// The bin runs the built CLI, so this needs `npm run build` (CI builds first)
describe.skipIf(!built)("realbathy-to-xyz", () => {
  async function run(...args: string[]) {
    const dir = await mkdtemp(join(tmpdir(), "realbathy-"));
    const file = join(dir, "1.trl");
    await writeFile(
      file,
      trl([{ lat: 1, lon: 2, depthCm: 300, seconds: 100 }]),
    );
    return spawnSync(
      process.execPath,
      [bin, ...args.map((a) => a.replace("TRACK", file))],
      { encoding: "utf8" },
    );
  }

  test("converts a track", async () => {
    const { status, stdout } = await run("--utc-offset", "-4", "TRACK");
    expect(status).toBe(0);
    expect(stdout).toEqual(
      "LON,LAT,DEPTH,TIME\n2,1,3,2016-01-01T04:01:40.000Z\n",
    );
  });

  test.each([[[]], [["TRACK"]], [["--utc-offset=", "TRACK"]]])(
    "requires an offset: %j",
    async (args) => {
      const { status, stderr } = await run(...args);
      expect(status).toBe(1);
      expect(stderr).toMatch(/^Usage:/);
    },
  );

  test("reports an offset out of range without a stack trace", async () => {
    const { status, stderr } = await run("--utc-offset", "15", "TRACK");
    expect(status).toBe(1);
    expect(stderr).toMatch(/^realbathy-to-xyz: utcOffset must be/);
  });
});
