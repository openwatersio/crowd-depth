// The tile service's worker thread: builds tiles from the plugin's database, opened
// read-only, so a tile's interpolation runs off the server's event loop.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createCellStore } from "./cells.js";
import { readTile } from "./service.js";

const db = new DatabaseSync(workerData.file, { readOnly: true });
const store = createCellStore(db);

parentPort!.on("message", ({ id, z, x, y }) => {
  try {
    // One read transaction, so a tile doesn't mix cells from before and after a write.
    db.exec("BEGIN");
    try {
      parentPort!.postMessage({ id, tile: readTile(store, z, x, y) });
    } finally {
      db.exec("COMMIT");
    }
  } catch (err) {
    parentPort!.postMessage({ id, error: String(err) });
  }
});
