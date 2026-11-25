import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openObservationStore,
  type Acquisition,
  type Observation,
} from "../../src/observations/store.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});

const acquisition: Acquisition = {
  kind: "live",
  depthPath: "environment.depth.belowTransducer",
  settings: { offset: 0.75, selectedSource: "preferred" },
};
const point: Observation = {
  timestamp: "2026-11-24T17:00:00.123456789Z",
  positionTimestamp: "2026-11-24T17:00:00.100000001Z",
  longitude: -80.123456789123,
  latitude: 26.123456789123,
  depth: 4.123456789123,
  headingTrue: 1.23456789123,
  speedOverGround: 0.01234,
  depthSource: "sounder.1",
  positionSource: "gps.2",
  gnss: {
    satellites: 12,
    horizontalDilution: 0.875,
    methodQuality: "DGNSS fix",
  },
};
const start = Date.parse(point.timestamp);
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "observations-"));
  dirs.push(dir);
  return join(dir, "observations.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("owned observation store", () => {
  it("preserves original precision, provenance and acquisition context across reopen", () => {
    const file = fixture();
    let store = openObservationStore(file);
    const chunk = store.append(acquisition, [point]);
    store.close();
    store = openObservationStore(file);
    try {
      expect(store.read(chunk.id)).toEqual({
        version: 1,
        acquisition,
        points: [point],
      });
      expect(store.query(start, start + 1)).toEqual([chunk]);
      expect(store.query(start + 1, start + 2)).toEqual([]);
      expect(store.append(acquisition, [point])).toEqual(chunk);
      expect(store.query(start, start + 1)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("keeps history aggregates and changed calibration distinct from live pings", () => {
    const store = openObservationStore(fixture());
    try {
      const live = store.append(acquisition, [point]);
      const history = store.append(
        { ...acquisition, kind: "history-aggregate" },
        [point],
      );
      const changed = store.append(
        { ...acquisition, settings: { offset: 1 } },
        [point],
      );
      expect(new Set([live.key, history.key, changed.key]).size).toBe(3);
      const unknown = { ...point };
      delete unknown.depthSource;
      delete unknown.positionSource;
      const chunk = store.append(acquisition, [unknown]);
      expect(store.read(chunk.id)?.points[0].depthSource).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("pages spatial candidates without losing out-of-order imports or boundary points", () => {
    const store = openObservationStore(fixture());
    try {
      const a = store.append(acquisition, [point]);
      const b = store.append(acquisition, [
        { ...point, timestamp: "2026-11-23T17:00:00Z" },
      ]);
      store.append(acquisition, [{ ...point, longitude: 12 }]);
      const bounds = [
        point.longitude,
        point.latitude,
        point.longitude,
        point.latitude,
      ] as const;
      const first = store.query(start - 86401000, start + 1, bounds, 0, 1);
      expect(first).toEqual([a]);
      expect(store.query(start - 86401000, start + 1, bounds, a.id, 1)).toEqual(
        [b],
      );
      expect(store.query(start - 86401000, start + 1, bounds, b.id, 1)).toEqual(
        [],
      );
    } finally {
      store.close();
    }
  });

  it("handles a viewport crossing the date line", () => {
    const store = openObservationStore(fixture());
    try {
      const a = store.append(acquisition, [{ ...point, longitude: 179.9 }]);
      const b = store.append(acquisition, [{ ...point, longitude: -179.9 }]);
      store.append(acquisition, [point]);
      expect(store.query(start, start + 1, [179, 20, -179, 30])).toEqual([
        a,
        b,
      ]);
    } finally {
      store.close();
    }
  });

  it("rolls back the chunk if its spatial index cannot commit", () => {
    const file = fixture(),
      store = openObservationStore(file),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_chunk AFTER INSERT ON observation_chunks BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
      );
      expect(() => store.append(acquisition, [point])).toThrow(
        "fixture failure",
      );
      expect(store.query(start, start + 1)).toEqual([]);
      db.exec("DROP TRIGGER fail_chunk");
      const chunk = store.append(acquisition, [point]);
      expect(store.query(start, start + 1, [-81, 25, -79, 27])).toEqual([
        chunk,
      ]);
    } finally {
      db.close();
      store.close();
    }
  });

  it("rejects invalid or unbounded inputs before writing", () => {
    const store = openObservationStore(fixture());
    try {
      for (const points of [
        [],
        Array(513).fill(point),
        [{ ...point, depth: NaN }],
        [{ ...point, longitude: 181 }],
        [{ ...point, timestamp: "bad" }],
      ])
        expect(() => store.append(acquisition, points)).toThrow();
      expect(() => store.query(start, start, undefined)).toThrow();
      expect(() => store.query(start, start + 1, undefined, 0, 129)).toThrow();
      expect(store.query(start, start + 1)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("detects damaged payloads rather than returning plausible observations", () => {
    const file = fixture(),
      store = openObservationStore(file),
      db = new DatabaseSync(file);
    try {
      const chunk = store.append(acquisition, [point]);
      db.prepare("UPDATE observation_chunks SET key=? WHERE id=?").run(
        "wrong",
        chunk.id,
      );
      expect(() => store.read(chunk.id)).toThrow("checksum mismatch");
    } finally {
      db.close();
      store.close();
    }
  });
});

it("records through a spatial-table fallback when RTree is unavailable", () => {
  const exec = DatabaseSync.prototype.exec;
  const spy = vi
    .spyOn(DatabaseSync.prototype, "exec")
    .mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes("CREATE VIRTUAL TABLE"))
        throw new Error("no such module: rtree_i32");
      return exec.call(this, sql);
    });
  let store: ReturnType<typeof openObservationStore> | undefined;
  try {
    store = openObservationStore(fixture());
    const chunk = store.append(acquisition, [point]);
    expect(store.query(start, start + 1, [-81, 25, -79, 27])).toEqual([chunk]);
  } finally {
    store?.close();
    spy.mockRestore();
  }
});
it("refuses a future schema without modifying its version", () => {
  const file = fixture(),
    db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=99");
  db.close();
  expect(() => openObservationStore(file)).toThrow(
    "Unsupported observation store version 99",
  );
  const reopened = new DatabaseSync(file);
  try {
    expect(reopened.prepare("PRAGMA user_version").get()?.user_version).toBe(
      99,
    );
  } finally {
    reopened.close();
  }
});

it("publishes only complete import manifests, including empty receipts", () => {
  const file = fixture();
  let store = openObservationStore(file);
  try {
    const chunk = store.append({ ...acquisition, kind: "history-aggregate" }, [
      point,
    ]);
    expect(store.imported("history", start, start + 1000)).toBeUndefined();
    expect(() =>
      store.publishImport("history", start, start + 1000, [chunk.id, 99999]),
    ).toThrow("missing");
    expect(store.imported("history", start, start + 1000)).toBeUndefined();
    store.publishImport("history", start, start + 1000, [chunk.id], 123);
    store.close();
    store = openObservationStore(file);
    expect(store.imported("history", start, start + 1000)).toEqual({
      recorded: 123,
      chunks: [chunk.id],
      fresh: false,
    });
    store.publishImport("history", start, start + 1000, [], 456);
    expect(store.imported("history", start, start + 1000)).toEqual({
      recorded: 456,
      chunks: [],
      fresh: false,
    });
    expect(store.read(chunk.id)?.points).toEqual([point]);
  } finally {
    store.close();
  }
});

it("preserves SQLITE_FULL when SQLite has already rolled back the transaction", () => {
  const store = openObservationStore(fixture());
  const exec = DatabaseSync.prototype.exec;
  let armed = true;
  const spy = vi
    .spyOn(DatabaseSync.prototype, "exec")
    .mockImplementation(function (this: DatabaseSync, sql: string) {
      if (armed && sql === "BEGIN IMMEDIATE") {
        armed = false;
        const pages = Number(
          this.prepare("PRAGMA page_count").get()!.page_count,
        );
        exec.call(this, `PRAGMA max_page_count=${pages + 1}`);
      }
      return exec.call(this, sql);
    });
  try {
    expect(() =>
      store.append(
        {
          ...acquisition,
          settings: { entropy: randomBytes(100000).toString("base64") },
        },
        [point],
      ),
    ).toThrow("database or disk is full");
    expect(store.query(start, start + 1)).toEqual([]);
  } finally {
    spy.mockRestore();
    store.close();
  }
});

it("leaves filesystem reserve intact and can resume when space is available", () => {
  const store = openObservationStore(fixture());
  try {
    vi.mocked(statfsSync).mockReturnValueOnce({
      bavail: 1,
      bsize: 4096,
    } as never);
    expect(() => store.append(acquisition, [point])).toThrow(
      "storage reserve reached",
    );
    expect(store.query(start, start + 1)).toEqual([]);
    expect(store.append(acquisition, [point]).count).toBe(1);
  } finally {
    store.close();
  }
});
it("distinguishes repeated live batches while making each batch retry idempotent", () => {
  const store = openObservationStore(fixture());
  try {
    const first = store.append(acquisition, [point], "capture-1");
    expect(store.append(acquisition, [point], "capture-1")).toEqual(first);
    expect(store.append(acquisition, [point], "capture-2").id).not.toBe(
      first.id,
    );
    expect(store.query(start, start + 1)).toHaveLength(2);
  } finally {
    store.close();
  }
});

it("expires empty and populated receipts without deleting the last readable manifest", () => {
  const store = openObservationStore(fixture());
  try {
    store.publishImport("empty", start, start + 1, [], 1000);
    expect(store.imported("empty", start, start + 1, 1000)?.fresh).toBe(true);
    expect(store.imported("empty", start, start + 1, 301000)?.fresh).toBe(
      false,
    );
    const chunk = store.append(acquisition, [point]);
    store.publishImport("full", start, start + 1, [chunk.id], 1000);
    expect(store.imported("full", start, start + 1, 301000)?.fresh).toBe(true);
    expect(store.imported("full", start, start + 1, 86401000)).toEqual({
      recorded: 1000,
      chunks: [chunk.id],
      fresh: false,
    });
    expect(store.imported("full", start, start + 1, 999)?.fresh).toBe(false);
  } finally {
    store.close();
  }
});

it("spatial hints exclude abandoned and superseded imports and migrate v1 receipts", () => {
  const file = fixture();
  let store = openObservationStore(file);
  const old = store.append(acquisition, [point]);
  const replacement = store.append(acquisition, [{ ...point, longitude: 12 }]);
  const west = [-81, 25, -79, 27] as const;
  expect(store.importedInView("history", start, start + 1000, west)).toEqual(
    [],
  );
  store.publishImport("history", start, start + 1000, [old.id]);
  expect(store.importedInView("history", start, start + 1000, west)).toEqual([
    { start, end: start + 1000 },
  ]);
  store.close();
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE observation_import_parts; PRAGMA user_version=1");
  db.close();
  store = openObservationStore(file);
  try {
    expect(store.importedInView("history", start, start + 1000, west)).toEqual([
      { start, end: start + 1000 },
    ]);
    store.publishImport("history", start, start + 1000, [replacement.id]);
    expect(store.importedInView("history", start, start + 1000, west)).toEqual(
      [],
    );
    expect(
      store.importedInView("history", start, start + 1000, [11, 25, 13, 27]),
    ).toEqual([{ start, end: start + 1000 }]);
    expect(store.read(old.id)!.points).toEqual([point]);
    store.publishImport("history", start, start + 1000, []);
    expect(
      store.importedInView("history", start, start + 1000, [11, 25, 13, 27]),
    ).toEqual([]);
  } finally {
    store.close();
  }
});
