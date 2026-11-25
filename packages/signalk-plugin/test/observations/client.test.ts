import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Exercise the actual built worker, as production does.
import { createObservationStore } from "../../dist/observations/client.js";
const context = {
  kind: "live" as const,
  depthPath: "environment.depth.belowSurface",
  settings: {},
};
const point = {
  timestamp: "2026-11-24T12:00:00.123456789Z",
  longitude: -80,
  latitude: 26,
  depth: 3,
};
it("drains admitted writes on immediate close and reopens durable data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-worker-")),
    file = join(dir, "observations.sqlite");
  try {
    const store = createObservationStore(file);
    const write = store.append(context, [point]);
    const closed = store.close();
    const chunk = await write;
    await closed;
    await expect(store.append(context, [point])).rejects.toThrow("closing");
    const reopened = createObservationStore(file);
    try {
      expect((await reopened.read(chunk.id))?.points).toEqual([point]);
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("rejects excess queued work while preserving accepted writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-worker-"));
  const store = createObservationStore(join(dir, "observations.sqlite"));
  try {
    const writes = Array.from({ length: 16 }, () =>
      store.append(context, [point]),
    );
    await expect(store.append(context, [point])).rejects.toThrow("queue full");
    expect(new Set((await Promise.all(writes)).map((c) => c.id)).size).toBe(1);
    await expect(
      store.append(context, [{ ...point, depth: NaN }]),
    ).rejects.toThrow("Invalid observation");
    expect((await store.append(context, [point])).count).toBe(1);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("reports initialization failures and finishes shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-worker-"));
  try {
    const store = createObservationStore(
      join(dir, "missing", "observations.sqlite"),
    );
    await expect(store.append(context, [point])).rejects.toThrow();
    await expect(store.close()).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
