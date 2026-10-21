// The tile service's worker thread: builds tiles from the plugin's database, opened
// read-only, so a tile's interpolation runs off the server's event loop.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createCellStore } from "./cells.js";
import { clearShared, readTile } from "./service.js";

const db = new DatabaseSync(workerData.file, { readOnly: true });
const store = createCellStore(db);
// Changes whenever another connection commits, as a backfill does on a thread of its
// own: then the surfaces kept for tiles to share are dropped.
const version = db.prepare("PRAGMA data_version");
let seen: unknown;

parentPort!.on("message", ({ id, z, x, y, clear }) => {
  if (clear) {
    clearShared(store, clear === true ? undefined : clear);
    return;
  }
  try {
    // One read transaction, so a tile doesn't mix cells from before and after a write.
    db.exec("BEGIN");
    try {
      const now = (version.get() as { data_version: number }).data_version;
      if (now !== seen) clearShared(store);
      seen = now;
      parentPort!.postMessage({
        id,
        tile: readTile(store, z, x, y, workerData.detail),
      });
    } finally {
      db.exec("COMMIT");
    }
  } catch (err) {
    parentPort!.postMessage({ id, error: String(err) });
  }
});
