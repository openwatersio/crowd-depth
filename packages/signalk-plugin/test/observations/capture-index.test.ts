import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openObservationStore,
  type Acquisition,
} from "../../src/observations/store.js";

const acquisition: Acquisition = {
  kind: "live",
  depthPath: "environment.depth.belowSurface",
  settings: { source: "gps" },
};
const identity = JSON.stringify(acquisition);
const start = Date.parse("2026-11-24T12:00:00Z");
const point = (i = 0) => ({
  timestamp: new Date(start + i * 1000).toISOString(),
  longitude: -80,
  latitude: 26,
  depth: 5 + i / 100,
});
const bounds = [-81, 25, -79, 27] as const;

it("indexes live originals atomically without publishing a history receipt", () => {
  const store = openObservationStore(":memory:");
  try {
    const saved = store.append(acquisition, [point()]);
    expect(
      store.capturedPageInView(identity, start, start + 1000, bounds).chunks,
    ).toEqual([saved]);
    expect(store.imported(identity, start, start + 1000)).toBeUndefined();
    store.append({ ...acquisition, kind: "history-aggregate" }, [point(1)]);
    expect(
      store.capturedPageInView(identity, start, start + 10000, bounds).chunks,
    ).toHaveLength(1);
    expect(
      store.capturedPageInView(identity, start, start + 10000, [0, 0, 1, 1])
        .chunks,
    ).toEqual([]);
  } finally {
    store.close();
  }
});

it("pages dense anchored captures without repeats or missing IDs", () => {
  const store = openObservationStore(":memory:");
  try {
    const ids = [];
    for (let i = 0; i < 257; i++)
      ids.push(store.append(acquisition, [point(i)]).id);
    store.append({ ...acquisition, settings: { source: "other" } }, [point()]);
    const found = [];
    let before: number | undefined;
    do {
      const page = store.capturedPageInView(
        identity,
        start,
        start + 300000,
        bounds,
        before,
      );
      expect(page.chunks.length).toBeLessThanOrEqual(64);
      if (before !== undefined && page.before !== undefined)
        expect(page.before).toBeLessThan(before);
      found.push(...page.chunks.map((c) => c.id));
      before = page.before;
    } while (before !== undefined);
    expect(found.sort((a, b) => a - b)).toEqual(ids);
  } finally {
    store.close();
  }
});

it("migrates at most sixteen old chunks and detects appends after an older writer ran", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-index-")),
    file = join(dir, "observations.sqlite");
  let store = openObservationStore(file);
  const db = new DatabaseSync(file);
  try {
    for (let i = 0; i < 35; i++) store.append(acquisition, [point(i)]);
    const originals = db
      .prepare("SELECT key,data FROM observation_chunks ORDER BY id")
      .all();
    db.exec("DELETE FROM observation_capture_spatial");
    store.close();
    store = openObservationStore(file);
    expect(
      store.capturedPageInView(identity, start, start + 60000, bounds).chunks,
    ).toEqual([]);
    const first = store.indexCapturedPage();
    expect(first).toMatchObject({
      processed: 16,
      done: false,
      incomplete: false,
      errors: [],
    });
    expect(
      store.capturedPageInView(identity, start, start + 60000, bounds).chunks,
    ).toHaveLength(16);
    let progress = first;
    while (!progress.done) {
      progress = store.indexCapturedPage();
      expect(progress.processed).toBeLessThanOrEqual(16);
    }
    expect(
      store.capturedPageInView(identity, start, start + 60000, bounds).chunks,
    ).toHaveLength(35);
    expect(
      db.prepare("SELECT key,data FROM observation_chunks ORDER BY id").all(),
    ).toEqual(originals);
    const added = store.append(acquisition, [point(40)]);
    // Older code appends original bytes but does not maintain this derived index.
    db.prepare("DELETE FROM observation_capture_spatial WHERE id=?").run(
      added.id,
    );
    store.close();
    store = openObservationStore(file);
    expect(store.indexCapturedPage()).toMatchObject({
      processed: 1,
      done: true,
      incomplete: false,
    });
    expect(
      store.capturedPageInView(identity, start, start + 60000, bounds).chunks,
    ).toHaveLength(36);
  } finally {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("quarantines unreadable originals without discarding them or blocking new capture", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-corrupt-")),
    file = join(dir, "observations.sqlite");
  const store = openObservationStore(file),
    db = new DatabaseSync(file);
  try {
    const bad = store.append(acquisition, [point()]);
    db.prepare("UPDATE observation_chunks SET data=x'00' WHERE id=?").run(
      bad.id,
    );
    db.prepare("DELETE FROM observation_capture_spatial WHERE id=?").run(
      bad.id,
    );
    const good = store.append(acquisition, [point(1)]);
    const progress = store.indexCapturedPage();
    expect(progress.done).toBe(true);
    expect(progress.incomplete).toBe(true);
    expect(progress.errors.map((e) => e.id)).toEqual([bad.id]);
    expect(
      store.capturedPageInView(identity, start, start + 10000, bounds).chunks,
    ).toEqual([good]);
    expect(
      db.prepare("SELECT count(*) n FROM observation_chunks").get()!.n,
    ).toBe(2);
    expect(store.append(acquisition, [point()]).id).toBe(bad.id);
    expect(store.indexCapturedPage()).toMatchObject({
      done: true,
      incomplete: false,
    });
    expect(
      store.capturedPageInView(identity, start, start + 10000, bounds).chunks,
    ).toHaveLength(2);
  } finally {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("deduplicates dateline candidates and validates query bounds", () => {
  const store = openObservationStore(":memory:");
  try {
    const saved = store.append(acquisition, [
      { ...point(), longitude: 179.9 },
      { ...point(1), longitude: -179.9 },
    ]);
    expect(
      store.capturedPageInView(
        identity,
        start,
        start + 2000,
        [179, 25, -179, 27],
      ).chunks,
    ).toEqual([saved]);
    expect(() =>
      store.capturedPageInView(identity, start, start, bounds),
    ).toThrow();
    expect(() =>
      store.capturedPageInView(identity, start, start + 1, [0, 0, NaN, 1]),
    ).toThrow();
  } finally {
    store.close();
  }
});

it("rebuilds time headers from verified originals before publishing discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-headers-"));
  const file = join(dir, "observations.sqlite");
  const store = openObservationStore(file);
  const db = new DatabaseSync(file);
  try {
    const saved = store.append(acquisition, [point()]);
    db.exec(
      "DELETE FROM observation_capture_spatial; UPDATE observation_chunks SET start=0,end=0,count=999",
    );
    expect(store.indexCapturedPage().incomplete).toBe(false);
    expect(
      store.capturedPageInView(identity, start, start + 1, bounds).chunks,
    ).toEqual([saved]);
  } finally {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("repairs discovery headers when identical originals are appended again", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-retry-"));
  const file = join(dir, "observations.sqlite");
  const store = openObservationStore(file);
  const db = new DatabaseSync(file);
  try {
    const saved = store.append(acquisition, [point()]);
    db.exec("UPDATE observation_chunks SET start=0,end=0,count=999");
    expect(store.append(acquisition, [point()])).toEqual(saved);
    expect(
      store.capturedPageInView(identity, start, start + 1, bounds).chunks,
    ).toEqual([saved]);
  } finally {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("advances across empty same-day candidate pages without losing an older matching chunk", () => {
  const store = openObservationStore(":memory:");
  try {
    const saved = store.append(acquisition, [point()]);
    for (let i = 1; i < 258; i++) store.append(acquisition, [point(i)]);
    let before: number | undefined;
    let emptyPages = 0;
    const found = [];
    do {
      const page = store.capturedPageInView(
        identity,
        start,
        start + 1,
        bounds,
        before,
      );
      if (!page.chunks.length && page.before !== undefined) emptyPages++;
      found.push(...page.chunks);
      before = page.before;
    } while (before !== undefined);
    expect(emptyPages).toBeGreaterThan(0);
    expect(found).toEqual([saved]);
  } finally {
    store.close();
  }
});
