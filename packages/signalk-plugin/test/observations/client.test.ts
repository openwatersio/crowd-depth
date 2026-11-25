import { ObservationDataError } from "../../dist/observations/errors.js";
import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
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

it("serializes concurrent v1 migrations from capture and chart workers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-migration-"));
  const file = join(dir, "observations.sqlite");
  const seed = createObservationStore(file);
  const chunk = await seed.append(context, [point]);
  const start = Date.parse(point.timestamp);
  await seed.publishImport("history", start, start + 1000, [chunk.id]);
  await seed.close();
  const db = new DatabaseSync(file);
  db.exec(
    "DROP TABLE observation_import_spatial; DROP TABLE observation_import_windows; DROP TABLE observation_import_contexts; PRAGMA user_version=1; BEGIN IMMEDIATE",
  );
  const a = createObservationStore(file),
    b = createObservationStore(file);
  try {
    // Both openers contend with the same held migration lock.
    await sleep(250);
    db.exec("COMMIT");
    await Promise.all([a.ready, b.ready]);
    expect(
      await a.importedInView(
        "history",
        start,
        start + 1000,
        [-81, 25, -79, 27],
      ),
    ).toEqual([{ start, end: start + 1000 }]);
    expect(await b.read(chunk.id)).toMatchObject({ points: [point] });
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    await Promise.all([a.close(), b.close()]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("preserves permanent data-error identity across the worker boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-corrupt-worker-"));
  const file = join(dir, "observations.sqlite");
  const store = createObservationStore(file);
  try {
    const chunk = await store.append(context, [point]);
    const db = new DatabaseSync(file);
    try {
      db.prepare("UPDATE observation_chunks SET data=? WHERE id=?").run(
        Buffer.from("broken compressed data"),
        chunk.id,
      );
    } finally {
      db.close();
    }
    await expect(store.read(chunk.id)).rejects.toBeInstanceOf(
      ObservationDataError,
    );
    await expect(store.read(chunk.id)).rejects.toThrow("unreadable");
    const healthy = await store.append(context, [{ ...point, depth: 4 }]);
    expect((await store.read(healthy.id))?.points[0].depth).toBe(4);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("bounds merged worker readers and streams at most one chunk per page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owned-read-pages-")),
    store = createObservationStore(join(dir, "observations.sqlite"));
  try {
    const points = Array.from({ length: 513 }, (_, i) => ({
      ...point,
      depth: i + 1,
    }));
    const chunks = [
      (await store.append(context, points.slice(0, 512))).id,
      (await store.append(context, points.slice(512))).id,
    ];
    const from = Date.parse(point.timestamp),
      to = from + 1000;
    const snapshots = [
      { start: from, end: to, recorded: 1, chunks, stage: "full" as const },
    ];
    const open = () =>
      store.openMergedRead(JSON.stringify(context), snapshots, from, to);
    const a = await open(),
      b = await open();
    let admitted = false;
    const waiting = open().then((id) => {
      admitted = true;
      return id;
    });
    await store.imported("barrier", 0, 1);
    expect(admitted).toBe(false);
    expect(await store.readMergedPage(a)).toEqual({
      points: points.slice(0, 512),
      done: false,
    });
    expect(await store.readMergedPage(a)).toEqual({
      points: points.slice(512),
      done: true,
    });
    const queuedReader = await waiting;
    const queued = Array.from({ length: 16 }, () =>
      store.imported("absent", 0, 1),
    );
    await Promise.all([...queued, store.closeMergedRead(b)]);
    const c = await open();
    await store.closeMergedRead(b);
    await store.closeMergedRead(c);
    await store.closeMergedRead(queuedReader);
    const d = await open();
    await store.closeMergedRead(d);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects queued reader opens and releases their buffers during shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owned-read-shutdown-"));
  const store = createObservationStore(join(dir, "observations.sqlite"));
  try {
    await store.openMergedRead("empty", [], 0, 1);
    await store.openMergedRead("empty", [], 0, 1);
    const queued = store.openMergedRead("empty", [], 0, 1);
    const rejected = expect(queued).rejects.toThrow("closing");
    await store.imported("barrier", 0, 1);
    await store.close();
    await rejected;
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
