import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createObservationStore } from "../../dist/observations/client.js";

test("the actual v2 checkpoint archive upgrades through the production worker without rewriting originals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "original-v2-upgrade-")),
    file = join(dir, "observations.sqlite");
  const bytes = gunzipSync(
    readFileSync(
      new URL("./fixtures/observations-v2.sqlite.gz", import.meta.url),
    ),
  );
  const metadata = JSON.parse(
    readFileSync(
      new URL("./fixtures/observations-v2.json", import.meta.url),
      "utf8",
    ),
  );
  expect(metadata.commit).toBe("531bc819");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    metadata.databaseSha256,
  );
  writeFileSync(file, bytes);
  const original = new DatabaseSync(file);
  expect(original.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
  const columns = original
    .prepare("PRAGMA table_info(observation_imports)")
    .all()
    .map((c) => c.name);
  expect(columns).not.toContain("stage");
  expect(columns).not.toContain("origins");
  const before = original
    .prepare("SELECT key,data FROM observation_chunks WHERE id=1")
    .get();
  original.close();
  const store = createObservationStore(file);
  try {
    await store.ready;
    const acquisition = {
      kind: "history-aggregate" as const,
      depthPath: "environment.depth.belowSurface",
      settings: {},
    };
    const identity = JSON.stringify(acquisition),
      start = Date.parse("2026-01-01T00:00:00Z");
    expect(
      await store.imported(identity, start, start + 3600000),
    ).toMatchObject({
      recorded: 0,
      stage: "preview",
      fresh: false,
      chunks: [1],
    });
    expect(
      await store.importedInView(
        identity,
        start,
        start + 3600000,
        [-81, 25, -79, 27],
      ),
    ).toEqual([{ start, end: start + 3600000 }]);
    const chunk = await store.read(1);
    expect(chunk?.points).toEqual([
      {
        timestamp: "2026-01-01T00:00:00.123456789Z",
        longitude: -80,
        latitude: 26,
        depth: 5,
        depthSource: "fixture-depth",
        positionSource: "fixture-gps",
      },
    ]);
    const next = await store.append({ ...acquisition, kind: "live" }, [
      { ...chunk!.points[0], depth: 6 },
    ]);
    expect((await store.read(next.id))?.points[0].depth).toBe(6);
    const upgraded = new DatabaseSync(file, { readOnly: true });
    try {
      expect(upgraded.prepare("PRAGMA user_version").get()!.user_version).toBe(
        7,
      );
      expect(
        upgraded
          .prepare("SELECT key,data FROM observation_chunks WHERE id=1")
          .get(),
      ).toEqual(before);
    } finally {
      upgraded.close();
    }
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
