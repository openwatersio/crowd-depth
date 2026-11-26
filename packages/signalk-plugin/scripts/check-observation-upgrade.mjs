// Rehearse archive upgrade, explicit snapshot rollback, and preservation for roll-forward.
// Both stores operate only on synthetic data in a new temporary directory.
// node scripts/check-observation-upgrade.mjs <older-store-module> <fixture-parent>
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import { openObservationStore } from "../dist/observations/store.js";

const [oldModule, parent] = process.argv.slice(2);
assert(oldModule && parent, "provide an older store module and fixture parent");
const { openObservationStore: oldStore } = await import(
  pathToFileURL(resolve(oldModule)).href
);
const dir = mkdtempSync(join(parent, "observation-upgrade-check-"));
const file = join(dir, "observations.sqlite");
const snapshot = join(dir, "before-upgrade.sqlite");
const retained = join(dir, "preserved-upgraded.sqlite");
const acquisition = {
  kind: "history-aggregate",
  depthPath: "environment.depth.belowTransducer",
  settings: {},
};
const point = {
  timestamp: "2026-01-01T00:00:00Z",
  longitude: -80,
  latitude: 26,
  depth: 5,
};
const identity = JSON.stringify(acquisition);
const start = Date.parse(point.timestamp);
const acquiredAt = Date.now() - 2000;
let store;
try {
  store = oldStore(file);
  const first = store.append(acquisition, [point]);
  store.publishImport(identity, start, start + 3600000, [first.id], acquiredAt);
  const revision = store.append(acquisition, [{ ...point, depth: 7 }]);
  store.publishImport(
    identity,
    start - 1800000,
    start + 1800000,
    [revision.id],
    acquiredAt + 1000,
  );
  store.close();
  store = undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  const fromSchema = db.prepare("PRAGMA user_version").get().user_version;
  await backup(db, snapshot);
  db.close();
  const check = new DatabaseSync(snapshot, { readOnly: true });
  assert.equal(check.prepare("PRAGMA quick_check").get().quick_check, "ok");
  check.close();
  store = openObservationStore(file);
  assert.deepEqual(store.read(first.id).points, [point]);
  assert.equal(store.imported(identity, start, start + 3600000).fresh, false);
  assert(
    store.importedInView(identity, start, start + 1000, [-81, 25, -79, 27])
      .length > 0,
  );
  if (fromSchema >= 3) {
    const replay = () => {
      const snapshots = [
        [start, start + 3600000],
        [start - 1800000, start + 1800000],
      ].map(([a, b]) => ({
        start: a,
        end: b,
        ...store.imported(identity, a, b),
      }));
      return store.readMergedPage(
        store.openMergedRead(identity, snapshots, start, start + 1000),
      ).points[0].depth;
    };
    assert.equal(replay(), 7);
    store.publishImport(
      identity,
      start,
      start + 3600000,
      [],
      acquiredAt + 2000,
      "backfill",
      "full",
    );
    assert.equal(replay(), 7);
  }
  const later = { ...point, timestamp: "2026-01-01T00:00:01Z", depth: 6 };
  const second = store.append(acquisition, [later]);
  store.close();
  store = undefined;
  assert.throws(() => oldStore(file), /Unsupported observation store version/);
  renameSync(file, retained);
  copyFileSync(snapshot, file);
  store = oldStore(file);
  assert.deepEqual(store.read(first.id).points, [point]);
  assert.equal(store.read(second.id), undefined);
  store.close();
  store = undefined;
  store = openObservationStore(retained);
  assert.deepEqual(store.read(first.id).points, [point]);
  assert.deepEqual(store.read(second.id).points, [later]);
  console.log(
    JSON.stringify({
      fromSchema,
      legacyRevisionOrderPreserved: fromSchema >= 3,
      importFreshnessAndSpatialHintsChecked: true,
      olderOpenRefused: true,
      snapshotRollbackReadable: true,
      laterObservationsPreservedForRollForward: true,
    }),
  );
} finally {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}
