import { setPriority } from "node:os";
import { ObservationDataError, ObservationReadBusy } from "./errors.js";
import { parentPort, workerData } from "node:worker_threads";
import { openObservationStore } from "./store.js";
import type { Request } from "./client.js";

if (process.platform === "linux") {
  try {
    setPriority(10);
  } catch {}
}
const store = openObservationStore(workerData.file);
const queued: Request[] = [];
function execute({ id, operation, args }: Request): boolean {
  try {
    let value;
    switch (operation) {
      case "openMergedRead":
        value = store.openMergedRead(...args);
        break;
      case "readMergedPage":
        value = store.readMergedPage(...args);
        break;
      case "closeMergedRead":
        value = store.closeMergedRead(...args);
        break;
      case "publishImport":
        value = store.publishImport(...args);
        break;
      case "imported":
        value = store.imported(...args);
        break;
      case "importedInView":
        value = store.importedInView(...args);
        break;
      case "importedPageInView":
        value = store.importedPageInView(...args);
        break;
      case "indexCapturedPage":
        value = store.indexCapturedPage();
        break;
      case "capturedPageInView":
        value = store.capturedPageInView(...args);
        break;
      case "append":
        value = store.append(...args);
        break;
      case "query":
        value = store.query(...args);
        break;
      case "readRange":
        value = store.readRange(...args);
        break;
      case "read":
        value = store.read(...args);
        break;
      case "close":
        store.close();
        break;
      default: {
        const unknown: never = operation;
        throw new Error(`Unknown observation operation ${unknown}`);
      }
    }
    parentPort!.postMessage({ id, value });
  } catch (error) {
    if (error instanceof ObservationReadBusy) return false;
    parentPort!.postMessage({
      id,
      error: String(error),
      permanent: error instanceof ObservationDataError,
    });
  } finally {
    if (operation === "close") parentPort!.close();
  }
  return true;
}
parentPort!.on("message", (message: Request) => {
  if (message.operation === "close") {
    for (const pending of queued.splice(0))
      parentPort!.postMessage({
        id: pending.id,
        error: "Observation store is closing",
      });
    execute(message);
    return;
  }
  if (!execute(message)) {
    if (queued.length >= 16)
      parentPort!.postMessage({
        id: message.id,
        error: "Observation worker request queue full",
      });
    else queued.push(message);
  }
  if (
    message.operation === "readMergedPage" ||
    message.operation === "closeMergedRead"
  ) {
    while (queued.length && execute(queued[0])) queued.shift();
  }
});
parentPort!.postMessage({ ready: true });
