// The backfill's worker thread: folds a backfill's soundings into the cells on its own
// connection to the plugin's database, so a long backfill's writes, on an SD card many
// seconds at a time, never hold up the Signal K server. The live writer holds its
// passes meanwhile, so the two don't write cells at once.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { createCellStore } from "./cells.js";
import { createCellWriter } from "./writer.js";

const db = new DatabaseSync(workerData.file);
// The plugin's own connection still writes its sounding log meanwhile.
db.exec("PRAGMA busy_timeout = 10000");
const store = createCellStore(db);
const writer = createCellWriter(store, { bulk: true, overviews: false });

type Sent = {
  longitude: number;
  latitude: number;
  depth: number;
  time: number;
  heading?: number;
};

parentPort!.on("message", (msg: { batch?: Sent[]; end?: true }) => {
  try {
    if (msg.batch) {
      for (const s of msg.batch) {
        writer.write({
          longitude: s.longitude,
          latitude: s.latitude,
          depth: s.depth,
          heading: s.heading,
          timestamp: Temporal.Instant.fromEpochMilliseconds(s.time),
        });
      }
      parentPort!.postMessage({ ack: true });
    } else if (msg.end) {
      writer.end(() => {
        store.rebuildOverviews();
        db.close();
        parentPort!.postMessage({ done: true });
      });
    }
  } catch (err) {
    parentPort!.postMessage({ error: String(err) });
  }
});
