import { DatabaseSync } from "node:sqlite";
import { workerData, parentPort } from "node:worker_threads";
import { setPriority } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { keptTileSchema } from "../storage.js";
import { createKeptTiles, drawnBy } from "./kept.js";
if (process.platform === "linux") {
  try {
    setPriority(10);
  } catch {}
}
const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000");
try {
  const version = drawnBy();
  keptTileSchema(db);
  if (
    db
      .prepare("SELECT value FROM tile_meta WHERE key='kept_tiles_version'")
      .get()?.value !== version
  ) {
    // The service cannot read or reserve disk tiles until this worker exits.
    // Bounded deletes yield the write lock to recording and refinement.
    const drop = db.prepare(
      "DELETE FROM kept_tiles WHERE id IN (SELECT id FROM kept_tiles ORDER BY id LIMIT 128)",
    );
    while (Number(drop.run().changes)) await sleep(25);
    db.prepare(
      "INSERT OR REPLACE INTO tile_meta VALUES('kept_tiles_version',?)",
    ).run(version);
  }
  createKeptTiles(db, workerData.detail, { version });
  parentPort!.postMessage({ version });
} finally {
  db.close();
}
