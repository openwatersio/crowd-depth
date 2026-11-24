// The tile service's worker thread: builds tiles from the plugin's database, opened
// read-only, so a tile's interpolation runs off the server's event loop.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createCellStore } from "./cells.js";
import { readPreview } from "./preview.js";
import { clearShared, readTile } from "./service.js";
import { setPriority } from "node:os";

// Keep Signal K's main thread responsive when a viewport needs several cold tiles.
if (process.platform === "linux") {
  try {
    setPriority(10);
  } catch {}
}

const db = new DatabaseSync(workerData.file, { readOnly: true });
const store = createCellStore(db);

parentPort!.on("message", ({ id, z, x, y, share, clear, preview }) => {
  if (clear) {
    clearShared(store, clear === true ? undefined : clear);
    return;
  }
  try {
    // One read transaction, so a tile doesn't mix cells from before and after a write.
    db.exec("BEGIN");
    try {
      parentPort!.postMessage(
        preview
          ? { id, preview: readPreview(store, preview, workerData.detail) }
          : { id, tile: readTile(store, z, x, y, workerData.detail, share) },
      );
    } finally {
      db.exec("COMMIT");
    }
  } catch (err) {
    parentPort!.postMessage({ id, error: String(err) });
  }
});
