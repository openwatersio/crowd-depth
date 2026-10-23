// The backfill's worker thread: folds a backfill's soundings into the cells on its own
// connection to the plugin's database, so a long backfill's writes, on an SD card many
// seconds at a time, never hold up the Signal K server. The live writer holds its
// passes meanwhile, for up to 3 hours, so the two don't write cells at once.
import { parentPort, workerData } from "node:worker_threads";
import { setPriority } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { createCellStore } from "./cells.js";
import { createCellWriter } from "./writer.js";
import { advancePendingBackfill } from "./backfill.js";
import type { Tide } from "./tide.js";

// A lower CPU priority, so a backfill of years of soundings yields to the server and
// whatever else runs on the boat's computer. Linux keeps a nice value per thread, so
// this lowers only this one; elsewhere it would lower the whole server. Not the lowest:
// the server waits on this thread's transactions, and starved under load it would hold
// them open for longer.
if (process.platform === "linux") {
  try {
    setPriority(10);
  } catch {
    // A server already below this can't be raised to it without the right to.
  }
}

const db = new DatabaseSync(workerData.file);
// As the plugin's own connection: no sync on every commit, which wears an SD card, and
// a wait rather than a failure when that connection is writing its sounding log.
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 10000");
const store = createCellStore(db);
const writer = createCellWriter(store, {
  bulk: true,
  overviews: false,
  progress: (micros) => advancePendingBackfill(store, micros),
});
// A write that fails surfaces here, not from `write`, which only queues.
writer.on("error", (err) => parentPort!.postMessage({ error: String(err) }));

type Sent = {
  longitude: number;
  latitude: number;
  depth: number;
  time: number;
  heading?: number;
  tide?: Tide;
};

parentPort!.on(
  "message",
  (msg: { batch?: Sent[]; end?: true; rebuild?: true }) => {
    try {
      if (msg.rebuild) {
        store.rebuildOverviews();
        db.close();
        return parentPort!.postMessage({ done: true });
      }
      if (msg.batch) {
        for (const s of msg.batch) {
          writer.write({
            longitude: s.longitude,
            latitude: s.latitude,
            depth: s.depth,
            heading: s.heading,
            tide: s.tide,
            timestamp: Temporal.Instant.fromEpochMilliseconds(s.time),
          });
        }
        parentPort!.postMessage({ ack: true });
      } else if (msg.end) {
        writer.end((err?: Error | null) => {
          if (err) return parentPort!.postMessage({ error: String(err) });
          store.rebuildOverviews();
          db.close();
          parentPort!.postMessage({ done: true });
        });
      }
    } catch (err) {
      parentPort!.postMessage({ error: String(err) });
    }
  },
);
