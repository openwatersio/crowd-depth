import { parentPort, workerData } from "node:worker_threads";
import { openObservationStore } from "./store.js";
import type { Request } from "./client.js";

const store = openObservationStore(workerData.file);
parentPort!.on("message", ({ id, operation, args }: Request) => {
  try {
    let value;
    switch (operation) {
      case "publishImport":
        value = store.publishImport(...args);
        break;
      case "imported":
        value = store.imported(...args);
        break;
      case "importedInView":
        value = store.importedInView(...args);
        break;
      case "append":
        value = store.append(...args);
        break;
      case "query":
        value = store.query(...args);
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
    parentPort!.postMessage({ id, error: String(error) });
  } finally {
    if (operation === "close") parentPort!.close();
  }
});
parentPort!.postMessage({ ready: true });
