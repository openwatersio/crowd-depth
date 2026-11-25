// Regenerate the synthetic archive using the actual store at PR #261's v2 checkpoint.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const commit = "531bc819";
const source = execFileSync(
  "git",
  ["show", `${commit}:packages/signalk-plugin/src/observations/store.ts`],
  { encoding: "utf8" },
);
const dir = mkdtempSync(join(tmpdir(), "observation-v2-fixture-"));
try {
  const module = join(dir, "store.mts");
  writeFileSync(
    module,
    source.replace(
      '"@js-temporal/polyfill"',
      JSON.stringify(import.meta.resolve("@js-temporal/polyfill")),
    ),
  );
  const { openObservationStore } = await import(pathToFileURL(module).href);
  const file = join(dir, "observations.sqlite"),
    store = openObservationStore(file);
  const acquisition = {
    kind: "history-aggregate",
    depthPath: "environment.depth.belowSurface",
    settings: {},
  };
  const start = Date.parse("2026-01-01T00:00:00Z");
  try {
    const chunk = store.append(acquisition, [
      {
        timestamp: "2026-01-01T00:00:00.123456789Z",
        longitude: -80,
        latitude: 26,
        depth: 5,
        depthSource: "fixture-depth",
        positionSource: "fixture-gps",
      },
    ]);
    store.publishImport(
      JSON.stringify(acquisition),
      start,
      start + 3600000,
      [chunk.id],
      start + 86400000,
    );
  } finally {
    store.close();
  }
  const bytes = readFileSync(file);
  writeFileSync(
    new URL(
      "../test/observations/fixtures/observations-v2.sqlite.gz",
      import.meta.url,
    ),
    gzipSync(bytes),
  );
  writeFileSync(
    new URL(
      "../test/observations/fixtures/observations-v2.json",
      import.meta.url,
    ),
    JSON.stringify(
      {
        commit,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        databaseSha256: createHash("sha256").update(bytes).digest("hex"),
        node: process.version,
        synthetic: true,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
