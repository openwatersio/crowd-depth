import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { setPriority } from "node:os";
import { setTimeout } from "node:timers/promises";
import { createPreviewSpatial } from "./preview-spatial.js";
import { previewPriority } from "./preview-priority.js";
if (process.platform === "linux") {
  try {
    setPriority(10);
  } catch {}
}
const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000");
try {
  const spatial = createPreviewSpatial(db);
  let priority = workerData.view
    ? previewPriority(db, workerData.view)
    : undefined;
  parentPort!.on("message", ({ view }) => {
    priority = previewPriority(db, view);
  });
  while (!spatial.ready()) {
    if (priority && !priority.done)
      spatial.prioritize(workerData.generation, priority.next());
    if (spatial.fill(workerData.generation)) break;
    await setTimeout(25);
  }
  parentPort!.postMessage({ done: true });
} catch (error) {
  parentPort!.postMessage({ error: String(error) });
} finally {
  parentPort!.close();
  db.close();
}
