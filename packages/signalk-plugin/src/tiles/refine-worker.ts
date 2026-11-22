import { cellCenter } from "./geometry.js";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { finished } from "node:stream/promises";
import { setPriority } from "node:os";
import { createCellStore } from "./cells.js";
import { refinementWriter } from "./refine.js";
import type { BathymetryData } from "../types.js";
if (process.platform === "linux") {
  try {
    setPriority(10);
  } catch {}
}
const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000");
const store = createCellStore(db, workerData.generation);
let job: ReturnType<typeof refinementWriter> | undefined;
parentPort!.on(
  "message",
  async (message: {
    reweight?: boolean;
    start?: number;
    stop?: number;
    batch?: (Omit<BathymetryData, "timestamp"> & { timestamp: number })[];
    end?: boolean;
    commit?: boolean;
  }) => {
    try {
      if (message.reweight) {
        const result = store.reweightNext();
        parentPort!.postMessage({
          done: result.done,
          changed: result.changed.map((p) => cellCenter(p.py, p.px)),
        });
        return;
      }
      if (message.start !== undefined) {
        job = refinementWriter(store, message.start, message.stop!);
        // Errors are reported by the awaited write/final callbacks below.
        job.writer.on("error", () => {});
      }
      if (message.batch)
        for (const data of message.batch) {
          await new Promise<void>((resolve, reject) =>
            job!.writer.write(
              {
                ...data,
                timestamp: Temporal.Instant.fromEpochMilliseconds(
                  data.timestamp,
                ),
              },
              (err) => (err ? reject(err) : resolve()),
            ),
          );
        }
      if (message.end) {
        job!.writer.end();
        await finished(job!.writer);
        const changed = message.commit === false ? [] : job!.commit();
        job = undefined;
        parentPort!.postMessage({ changed });
      } else parentPort!.postMessage({ ack: true });
    } catch (err) {
      job?.writer.destroy();
      job = undefined;
      parentPort!.postMessage({ error: String(err) });
    }
  },
);
