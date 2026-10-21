// The tile service's worker thread: builds tiles from the plugin's database, opened
// read-only, so a tile's interpolation runs off the server's event loop.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createCellStore } from "./cells.js";
import { clearShared, readTile } from "./service.js";

const db = new DatabaseSync(workerData.file, { readOnly: true });
const store = createCellStore(db);

parentPort!.on("message", ({ id, z, x, y, share, clear }) => {
  if (clear) {
    clearShared(store, clear === true ? undefined : clear);
    return;
  }
  try {
    // One read transaction, so a tile doesn't mix cells from before and after a write.
    db.exec("BEGIN");
    try {
      parentPort!.postMessage({
        id,
        tile: readTile(store, z, x, y, workerData.detail, share),
      });
    } finally {
      db.exec("COMMIT");
    }
  } catch (err) {
    parentPort!.postMessage({ id, error: String(err) });
  }
});
