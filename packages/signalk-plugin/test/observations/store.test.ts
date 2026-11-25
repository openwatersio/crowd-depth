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
  it.each([false, true])(
    "does not promote retained observations when a refresh is partial=%s",
    (partial) => {
      const file = fixture();
      let store = openObservationStore(file);
      const context = { ...acquisition, kind: "history-aggregate" as const };
      const identity = JSON.stringify(context);
      const hour = 3600000;
      const time = start + 45 * 60000;
      const sample = {
        ...point,
        timestamp: new Date(time).toISOString(),
        depth: 5,
      };
      const first = store.append(context, [sample]);
      const revised = store.append(context, [{ ...sample, depth: 7 }]);
      const publish = (
        from: number,
        to: number,
        chunks: number[],
        recorded: number,
      ) =>
        store.publishImport(
          identity,
          from,
          to,
          chunks,
          recorded,
          "backfill",
          "full",
        );
      try {
        publish(start, start + hour, [first.id], 1000);
        publish(start + 30 * 60000, start + 90 * 60000, [revised.id], 2000);
        const chunks = partial
          ? [
              store.append(context, [
                {
                  ...sample,
                  timestamp: new Date(start + 10 * 60000).toISOString(),
                },
              ]).id,
            ]
          : [];
        publish(start, start + hour, chunks, 3000);
        store.close();
        store = openObservationStore(file);
        const snapshots = () =>
          [
            [start, start + hour],
            [start + 30 * 60000, start + 90 * 60000],
          ].map(([from, to]) => ({
            start: from,
            end: to,
            ...store.imported(identity, from, to)!,
          }));
        const id = store.openMergedRead(
          identity,
          snapshots(),
          start,
          start + hour,
        );
        const result = store.readMergedPage(id).points;
        expect(
          result.find((p) => p.timestamp === sample.timestamp)?.depth,
        ).toBe(7);
        // A genuinely new acquisition of the same bytes must still win.
        publish(start, start + hour, [first.id], 4000);
        const next = store.openMergedRead(
          identity,
          snapshots(),
          start,
          start + hour,
        );
        expect(
          store
            .readMergedPage(next)
            .points.find((p) => p.timestamp === sample.timestamp)?.depth,
        ).toBe(5);
      } finally {
        store.close();
      }
    },
  );

  it("keeps an unattributed calibrated group during partial refresh without attaching its metadata to new readings", () => {
    const store = openObservationStore(fixture());
    const context = { ...acquisition, kind: "history-aggregate" as const };
    const original = {
      ...point,
      depthSource: undefined,
      positionSource: undefined,
    };
    const revision = {
      ...original,
      depth: 9,
      headingTrue: undefined,
      speedOverGround: undefined,
      gnss: undefined,
    };
    const later = { ...revision, timestamp: "2026-11-24T17:00:01Z" };
    const publish = (
      points: Observation[],
      stage: "full" | "partial" | "preview",
    ) =>
      store.publishImport(
        "unknown",
        start,
        start + 2000,
        [store.append(context, points).id],
        Date.now(),
        "backfill",
        stage,
      );
    const current = () =>
      store
        .imported("unknown", start, start + 2000)!
        .chunks.flatMap((id) => store.read(id)!.points);
    try {
      publish([original], "full");
      publish([revision, later], "partial");
      expect(current()).toEqual([
        JSON.parse(JSON.stringify(original)),
        JSON.parse(JSON.stringify(later)),
      ]);
      expect(store.imported("unknown", start, start + 2000)?.stage).toBe(
        "partial",
      );
      publish([revision], "preview");
      expect(current()[0].depth).toBe(original.depth);
      publish([revision, later], "full");
      expect(current()[0].depth).toBe(9);
      expect(current()[0].headingTrue).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("retains optional evidence on matching observations without transferring it across actual sources", () => {
    const store = openObservationStore(fixture());
    const context = { ...acquisition, kind: "history-aggregate" as const };
    const publish = (p: Observation) =>
      store.publishImport(
        "metadata",
        start,
        start + 1000,
        [store.append(context, [p]).id],
        Date.now(),
        "backfill",
      );
    const current = () =>
      store.read(store.imported("metadata", start, start + 1000)!.chunks[0])!
        .points[0];
    try {
      publish(point);
      publish({
        ...point,
        depth: point.depth + 1,
        gnss: undefined,
        headingTrue: undefined,
        speedOverGround: undefined,
      });
      expect(current()).toMatchObject({
        depth: point.depth + 1,
        gnss: point.gnss,
        headingTrue: point.headingTrue,
        speedOverGround: point.speedOverGround,
      });
      publish({ ...point, gnss: { satellites: 8 } });
      expect(current().gnss).toEqual({ ...point.gnss, satellites: 8 });
      publish({ ...point, positionSource: "different.gps", gnss: undefined });
      expect(current().gnss).toBeUndefined();
      publish({ ...point, positionSource: undefined, gnss: undefined });
      expect(current().gnss).toBeUndefined();
    } finally {
      store.close();
    }
  });
  it("persists acquisition stage and prevents a late preview from downgrading a full import", () => {
    const file = fixture();
    let store = openObservationStore(file);
    const raw = store.append(acquisition, [{ ...point, gnss: undefined }]);
    const full = store.append(acquisition, [point]);
    store.publishImport(
      "stage",
      start,
      start + 1000,
      [raw.id],
      1,
      "replace",
      "preview",
    );
    store.close();
    store = openObservationStore(file);
    try {
      expect(store.imported("stage", start, start + 1000)?.stage).toBe(
        "preview",
      );
      store.publishImport("stage", start, start + 1000, [full.id], 2);
      store.publishImport(
        "stage",
        start,
        start + 1000,
        [raw.id],
        3,
        "backfill",
        "preview",
      );
      expect(store.imported("stage", start, start + 1000)).toMatchObject({
        recorded: 2,
        stage: "full",
        chunks: [full.id],
      });
    } finally {
      store.close();
    }
  });

  it("upgrades schema 4 receipts without claiming their metadata acquisition was complete", () => {
    const file = fixture();
    let store = openObservationStore(file);
    const raw = store.append(acquisition, [point]);
    store.publishImport("old", start, start + 1000, [raw.id]);
    store.close();
    const db = new DatabaseSync(file);
    db.exec(
      "ALTER TABLE observation_imports DROP COLUMN stage; PRAGMA user_version=4",
    );
    db.close();
    store = openObservationStore(file);
    try {
      expect(store.imported("old", start, start + 1000)?.stage).toBe("preview");
      expect(store.read(raw.id)?.points).toEqual([point]);
    } finally {
      store.close();
    }
  });
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
      stage: "full",
    });
    store.publishImport("history", start, start + 1000, [], 456);
    expect(store.imported("history", start, start + 1000)).toEqual({
      recorded: 456,
      chunks: [],
      fresh: false,
      stage: "full",
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
      stage: "full",
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
  db.exec(
    "DROP TABLE observation_import_spatial; DROP TABLE observation_import_windows; DROP TABLE observation_import_contexts; PRAGMA user_version=1",
  );
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

it("rolls back failed reconciliation without changing the prior manifest or originals", () => {
  const store = openObservationStore(fixture());
  try {
    const context = { ...acquisition, kind: "history-aggregate" as const };
    const old = store.append(context, [point]);
    store.publishImport("history", start, start + 1000, [old.id]);
    const update = store.append(context, [{ ...point, depth: 9 }]);
    const receipt = store.imported("history", start, start + 1000);
    const space = statfsSync(tmpdir());
    vi.mocked(statfsSync).mockReturnValueOnce({ ...space, bavail: 0 });
    expect(() =>
      store.publishImport(
        "history",
        start,
        start + 1000,
        [update.id],
        Date.now(),
        "backfill",
      ),
    ).toThrow("reserve reached");
    expect(store.imported("history", start, start + 1000)).toEqual(receipt);
    expect(store.read(old.id)!.points).toEqual([point]);
    store.publishImport(
      "history",
      start,
      start + 1000,
      [update.id],
      Date.now(),
      "backfill",
    );
    expect(store.imported("history", start, start + 1000)!.chunks).toEqual([
      update.id,
    ]);
  } finally {
    store.close();
  }
});

it("reconciles equivalent timestamp formats and preserves duplicate multiplicity within a new version", () => {
  const store = openObservationStore(fixture());
  try {
    const context = { ...acquisition, kind: "history-aggregate" as const };
    const old = store.append(context, [point, point]);
    store.publishImport("history", start, start + 1000, [old.id]);
    const replacement = {
      ...point,
      timestamp: "2026-11-24T12:00:00.123456789-05:00",
      depth: 9,
    };
    const incoming = store.append(context, [
      replacement,
      replacement,
      replacement,
    ]);
    store.publishImport(
      "history",
      start,
      start + 1000,
      [incoming.id],
      Date.now(),
      "backfill",
    );
    const result = store.imported("history", start, start + 1000)!;
    expect(result.chunks.flatMap((id) => store.read(id)!.points)).toEqual([
      replacement,
      replacement,
      replacement,
    ]);
    expect(store.read(old.id)!.points).toEqual([point, point]);
  } finally {
    store.close();
  }
});

it("migrates v2 membership rows to viewport indexes without rewriting originals", () => {
  const file = fixture();
  let store = openObservationStore(file);
  const saved = store.append({ ...acquisition, kind: "history-aggregate" }, [
    point,
  ]);
  store.publishImport("history", start, start + 1000, [saved.id]);
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`DROP TABLE observation_import_spatial; DROP TABLE observation_import_windows;
    DROP TABLE observation_import_contexts;
    CREATE TABLE observation_import_parts(identity TEXT,start INTEGER,end INTEGER,part INTEGER,chunk INTEGER,
      PRIMARY KEY(identity,start,end,part)) WITHOUT ROWID;
    INSERT INTO observation_import_parts SELECT i.identity,i.start,i.end,j.key,j.value FROM observation_imports i,json_each(i.chunks) j;
    PRAGMA user_version=2;`);
  const original = db
    .prepare("SELECT key,data FROM observation_chunks WHERE id=?")
    .get(saved.id);
  db.close();
  store = openObservationStore(file);
  try {
    expect(
      store.importedInView("history", start, start + 1000, [-81, 25, -79, 27]),
    ).toEqual([{ start, end: start + 1000 }]);
    const verified = new DatabaseSync(file);
    try {
      expect(
        verified
          .prepare("SELECT key,data FROM observation_chunks WHERE id=?")
          .get(saved.id),
      ).toEqual(original);
      expect(verified.prepare("PRAGMA user_version").get()!.user_version).toBe(
        7,
      );
      expect(
        verified
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='observation_import_parts'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      verified.close();
    }
  } finally {
    store.close();
  }
});

it("filters import hints by source context, exact time, and a dateline viewport", () => {
  const store = openObservationStore(fixture());
  try {
    const saved = store.append(acquisition, [{ ...point, longitude: 179.9 }]);
    store.publishImport("other", start, start + 1000, [saved.id]);
    const distant = store.append(acquisition, [point]);
    store.publishImport("history", start, start + 1000, [distant.id]);
    expect(
      store.importedInView("history", start, start + 1000, [179, 25, -179, 27]),
    ).toEqual([]);
    store.publishImport("history", start + 2000, start + 3000, [saved.id]);
    expect(
      store.importedInView("history", start, start + 1000, [179, 25, -179, 27]),
    ).toEqual([]);
    expect(
      store.importedInView("history", start, start + 3000, [179, 25, -179, 27]),
    ).toEqual([{ start: start + 2000, end: start + 3000 }]);
  } finally {
    store.close();
  }
});

it("pages every visible window once without relying on spatial traversal or chronological insertion order", () => {
  // Exercise the real index without timing 257 durable fixture commits on CI disks.
  const store = openObservationStore(":memory:");
  try {
    const chunk = store.append(acquisition, [point]);
    const expected = new Set<number>();
    for (let i = 0; i < 257; i++) {
      const time = start + ((i * 73) % 257) * 1000;
      expected.add(time);
      store.publishImport("history", time, time + 500, [chunk.id]);
    }
    let before: number | undefined;
    const seen: number[] = [];
    for (let pageCount = 0; pageCount < 257; pageCount++) {
      const page = store.importedPageInView(
        "history",
        start,
        start + 257000,
        [-81, 25, -79, 27],
        before,
      );
      expect(page.windows.length).toBeGreaterThan(0);
      expect(page.windows.length).toBeLessThanOrEqual(64);
      seen.push(...page.windows.map((w) => w.start));
      if (page.before === undefined) break;
      expect(page.before).toBeLessThan(before ?? Infinity);
      before = page.before;
    }
    expect(seen).toHaveLength(257);
    expect(new Set(seen)).toEqual(expected);
  } finally {
    store.close();
  }
});

it("upgrades v3 viewport indexes and revalidates ambiguous legacy revision ages", () => {
  const file = fixture();
  let store = openObservationStore(file);
  const chunk = store.append(acquisition, [point]);
  const recorded = Date.now();
  store.publishImport("history", start, start + 1000, [chunk.id], recorded);
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`DROP TABLE observation_import_spatial;
    CREATE VIRTUAL TABLE observation_import_spatial USING rtree_i32(
      id,min_lon,max_lon,min_lat,max_lat,min_context,max_context,min_day,max_day);
    PRAGMA user_version=3;`);
  db.prepare(
    `INSERT INTO observation_import_spatial SELECT w.id,s.min_lon,s.max_lon,s.min_lat,s.max_lat,
    c.id,c.id,CAST(w.start/86400000 AS INTEGER),CAST((w.end-1)/86400000 AS INTEGER)
    FROM observation_import_windows w JOIN observation_import_contexts c ON c.identity=w.identity
    CROSS JOIN observation_spatial s WHERE s.id=?`,
  ).run(chunk.id);
  db.close();
  store = openObservationStore(file);
  try {
    expect(store.imported("history", start, start + 1000)!.recorded).toBe(
      recorded,
    );
    expect(store.imported("history", start, start + 1000)!.fresh).toBe(false);
    expect(
      store.importedPageInView(
        "history",
        start,
        start + 1000,
        [-81, 25, -79, 27],
      ),
    ).toEqual({ windows: [{ start, end: start + 1000 }] });
    expect(store.read(chunk.id)!.points).toEqual([point]);
  } finally {
    store.close();
  }
});

it("repairs missing derived chunk bounds during an older archive migration", () => {
  const file = fixture();
  let store = openObservationStore(file);
  const chunk = store.append(acquisition, [point]);
  store.publishImport("repair", start, start + 1000, [chunk.id]);
  store.close();
  const db = new DatabaseSync(file);
  db.prepare("DELETE FROM observation_spatial WHERE id=?").run(chunk.id);
  db.exec("PRAGMA user_version=2");
  db.close();
  store = openObservationStore(file);
  try {
    expect(store.read(chunk.id)?.points).toEqual([point]);
    expect(
      store.importedInView("repair", start, start + 1000, [-81, 25, -79, 27]),
    ).toEqual([{ start, end: start + 1000 }]);
    expect(
      store.query(start, start + 1000, [-81, 25, -79, 27]).map((c) => c.id),
    ).toEqual([chunk.id]);
  } finally {
    store.close();
  }
});

it("repairs an identical reimport in place without changing published chunk IDs", () => {
  const file = fixture();
  const store = openObservationStore(file);
  const chunk = store.append(acquisition, [point]);
  store.publishImport("repair", start, start + 1000, [chunk.id]);
  const db = new DatabaseSync(file);
  try {
    db.prepare("UPDATE observation_chunks SET data=? WHERE id=?").run(
      Buffer.from("damaged"),
      chunk.id,
    );
    db.prepare("DELETE FROM observation_spatial WHERE id=?").run(chunk.id);
    expect(() => store.read(chunk.id)).toThrow("unreadable");
    expect(store.append(acquisition, [point]).id).toBe(chunk.id);
    expect(store.imported("repair", start, start + 1000)?.chunks).toEqual([
      chunk.id,
    ]);
    expect(store.read(chunk.id)?.points).toEqual([point]);
    expect(
      store.query(start, start + 1000, [-81, 25, -79, 27]).map((c) => c.id),
    ).toEqual([chunk.id]);
  } finally {
    db.close();
    store.close();
  }
});

it("does not copy one prior observation's metadata onto duplicate incoming matches", () => {
  const store = openObservationStore(fixture());
  const context = { ...acquisition, kind: "history-aggregate" as const };
  try {
    store.publishImport("duplicates", start, start + 1000, [
      store.append(context, [point]).id,
    ]);
    const incoming = {
      ...point,
      headingTrue: undefined,
      speedOverGround: undefined,
      gnss: undefined,
    };
    store.publishImport(
      "duplicates",
      start,
      start + 1000,
      [store.append(context, [incoming, { ...incoming, depth: 9 }]).id],
      Date.now(),
      "backfill",
    );
    const points = store
      .imported("duplicates", start, start + 1000)!
      .chunks.flatMap((id) => store.read(id)!.points);
    expect(points.map((p) => p.depth)).toEqual([point.depth, 9]);
    for (const p of points) {
      expect(p.headingTrue).toBeUndefined();
      expect(p.speedOverGround).toBeUndefined();
      expect(p.gnss).toBeUndefined();
    }
  } finally {
    store.close();
  }
});

it("does not decode a corrupt chunk outside the requested time range", () => {
  const file = fixture(),
    store = openObservationStore(file);
  const good = store.append(acquisition, [point]);
  const bad = store.append(acquisition, [
    { ...point, timestamp: new Date(start + 3600000).toISOString() },
  ]);
  const db = new DatabaseSync(file);
  try {
    db.prepare("UPDATE observation_chunks SET data=? WHERE id=?").run(
      Buffer.from("broken"),
      bad.id,
    );
    expect(store.readRange(bad.id, start, start + 1000)).toBeNull();
    const id = store.openMergedRead(
      JSON.stringify(acquisition),
      [
        {
          start,
          end: start + 7200000,
          recorded: 1,
          chunks: [good.id, bad.id],
          stage: "full",
        },
      ],
      start,
      start + 1000,
    );
    expect(store.readMergedPage(id)).toEqual({ points: [point], done: true });
    expect(() =>
      store.readRange(bad.id, start + 3600000, start + 3601000),
    ).toThrow("unreadable");
  } finally {
    db.close();
    store.close();
  }
});

it.each(["chunk", "manifest"])(
  "quarantines a damaged legacy %s without blocking capture or hiding its interval",
  (damage) => {
    const file = fixture();
    let store = openObservationStore(file);
    const context = { ...acquisition, kind: "history-aggregate" as const };
    const original = store.append(context, [point]);
    store.publishImport("damaged", start, start + 1000, [original.id]);
    for (let i = 1; i <= 70; i++) {
      const healthy = store.append(context, [
        { ...point, timestamp: new Date(start + i * 1000).toISOString() },
      ]);
      store.publishImport("healthy", start + i * 1000, start + (i + 1) * 1000, [
        healthy.id,
      ]);
    }
    store.close();
    let db = new DatabaseSync(file);
    db.exec("PRAGMA user_version=2");
    if (damage === "chunk") {
      db.prepare("DELETE FROM observation_spatial WHERE id=?").run(original.id);
      db.prepare("UPDATE observation_chunks SET data=? WHERE id=?").run(
        Buffer.from("damaged"),
        original.id,
      );
    } else
      db.prepare(
        "UPDATE observation_imports SET chunks='invalid json' WHERE identity='damaged'",
      ).run();
    db.close();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      store = openObservationStore(file);
      let before: number | undefined,
        healthyCount = 0;
      do {
        const page = store.importedPageInView(
          "healthy",
          start,
          start + 72000,
          [-180, -90, 180, 90],
          before,
        );
        healthyCount += page.windows.length;
        before = page.before;
      } while (before !== undefined);
      expect(healthyCount).toBe(70);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("live capture remains available"),
      );
      expect(
        store.importedInView("damaged", start, start + 1000, [10, 10, 11, 11]),
      ).toEqual([{ start, end: start + 1000 }]);
      if (damage === "chunk")
        expect(() => store.read(original.id)).toThrow("unreadable");
      else
        expect(() => store.imported("damaged", start, start + 1000)).toThrow(
          "manifest is unreadable",
        );
      const live = store.append(acquisition, [{ ...point, depth: 8 }]);
      expect(store.read(live.id)?.points[0].depth).toBe(8);
      // Preserve the damaged original rather than erasing the interval on upgrade.
      db = new DatabaseSync(file);
      expect(
        db.prepare("SELECT count(*) AS n FROM observation_import_errors").get()!
          .n,
      ).toBe(1);
      expect(
        db
          .prepare("SELECT 1 FROM observation_chunks WHERE id=?")
          .get(original.id),
      ).toBeDefined();
      db.close();
      store.close();
      store = openObservationStore(file);
      expect(store.read(live.id)?.points[0].depth).toBe(8);
      if (damage === "chunk") {
        expect(store.append(context, [point]).id).toBe(original.id);
        store.publishImport("damaged", start, start + 1000, [original.id]);
        expect(
          store.importedInView(
            "damaged",
            start,
            start + 1000,
            [10, 10, 11, 11],
          ),
        ).toEqual([]);
        db = new DatabaseSync(file);
        expect(
          db
            .prepare("SELECT count(*) AS n FROM observation_import_errors")
            .get()!.n,
        ).toBe(0);
        db.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        /* An open failure leaves the previous handle closed. */
      }
      warning.mockRestore();
    }
  },
);

it("keeps legacy overlap ordering through upgrade and an empty refresh", () => {
  const file = fixture();
  let store = openObservationStore(file);
  const context = { ...acquisition, kind: "history-aggregate" as const },
    identity = JSON.stringify(context);
  const first = store.append(context, [point]);
  const newer = store.append(context, [{ ...point, depth: 7 }]);
  store.publishImport(identity, start, start + 3600000, [first.id], 1000);
  store.publishImport(
    identity,
    start - 1800000,
    start + 1800000,
    [newer.id],
    2000,
  );
  store.close();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=6");
  db.close();
  store = openObservationStore(file);
  const replay = () => {
    const snapshots = [
      [start, start + 3600000],
      [start - 1800000, start + 1800000],
    ].map(([a, b]) => ({
      start: a,
      end: b,
      ...store.imported(identity, a, b)!,
    }));
    const id = store.openMergedRead(identity, snapshots, start, start + 1000);
    return store.readMergedPage(id).points[0].depth;
  };
  try {
    expect(store.imported(identity, start, start + 3600000)!.fresh).toBe(false);
    expect(replay()).toBe(7);
    store.publishImport(
      identity,
      start,
      start + 3600000,
      [],
      3000,
      "backfill",
      "full",
    );
    expect(replay()).toBe(7);
  } finally {
    store.close();
  }
});

it("repairs damaged revision metadata when every group is freshly reacquired", () => {
  const file = fixture(),
    store = openObservationStore(file);
  const context = { ...acquisition, kind: "history-aggregate" as const },
    identity = JSON.stringify(context);
  try {
    const original = store.append(context, [point]);
    store.publishImport(identity, start, start + 1000, [original.id], 1000);
    store.publishImport(
      identity,
      start,
      start + 1000,
      [],
      2000,
      "backfill",
      "full",
    );
    const db = new DatabaseSync(file);
    db.prepare("UPDATE observation_imports SET origins=?").run(
      Buffer.from("broken"),
    );
    db.close();
    const read = () =>
      store.openMergedRead(
        identity,
        [
          {
            start,
            end: start + 1000,
            ...store.imported(identity, start, start + 1000)!,
          },
        ],
        start,
        start + 1000,
      );
    expect(read).toThrow("origins are unreadable");
    const fresh = store.append(context, [{ ...point, depth: 8 }]);
    store.publishImport(
      identity,
      start,
      start + 1000,
      [fresh.id],
      3000,
      "backfill",
      "full",
    );
    expect(store.readMergedPage(read()).points[0].depth).toBe(8);
    expect(store.read(original.id)?.points).toEqual([point]);
  } finally {
    store.close();
  }
});

it("bounds same-day import candidates before filtering and continues empty pages", () => {
  const store = openObservationStore(":memory:");
  const identity = JSON.stringify(acquisition);
  const at = Date.parse(point.timestamp);
  try {
    for (let i = 0; i < 258; i++) {
      const time = at + i * 1000;
      const chunk = store.append(acquisition, [
        { ...point, timestamp: new Date(time).toISOString() },
      ]);
      store.publishImport(identity, time, time + 1, [chunk.id]);
    }
    let before: number | undefined;
    let emptyPages = 0;
    const windows = [];
    do {
      const page = store.importedPageInView(
        identity,
        at,
        at + 1,
        [-81, 25, -79, 27],
        before,
      );
      if (!page.windows.length && page.before !== undefined) emptyPages++;
      windows.push(...page.windows);
      before = page.before;
    } while (before !== undefined);
    expect(emptyPages).toBeGreaterThan(0);
    expect(windows).toEqual([{ start: at, end: at + 1 }]);
  } finally {
    store.close();
  }
});
