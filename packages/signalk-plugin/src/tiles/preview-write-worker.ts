import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { setPriority } from "node:os";
import { isolateDamagedPreview } from "./preview-spatial.js";
import { createPreviewWriter } from "./preview-write.js";
if (process.platform === "linux") {
  try {
    setPriority(10);
  } catch {}
}
const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000");
const write = (() => {
  try {
    return createPreviewWriter(db, workerData.generation);
  } catch (error) {
    if (!isolateDamagedPreview(db, error)) throw error;
    return createPreviewWriter(db, workerData.generation);
  }
})();
parentPort!.on("message", ({ id, source, points, window }) => {
  try {
    try {
      write(source, points, window);
    } catch (error) {
      if (!isolateDamagedPreview(db, error)) throw error;
      write(source, points, window);
    }
    parentPort!.postMessage({ id });
  } catch (error) {
    parentPort!.postMessage({ id, error: String(error) });
  }
});
