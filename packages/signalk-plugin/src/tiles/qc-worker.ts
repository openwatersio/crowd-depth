import { parentPort } from "node:worker_threads";
import { trackQC, type Sounding } from "../qc.js";
import { DEFINITIONS } from "./geometry.js";
import { FLAG_NAMES } from "./qc-thread.js";

/** Runs the live writer's track QC off the server's main thread; see qc-thread.ts. */
parentPort!.on(
  "message",
  ({
    id,
    data,
    arrival,
  }: {
    id: number;
    data: Float64Array;
    arrival: number;
  }) => {
    try {
      const soundings: Sounding[] = [];
      for (let i = 0; i < data.length; i += 4) {
        soundings.push({
          time: data[i],
          lon: data[i + 1],
          lat: data[i + 2],
          depth: data[i + 3],
        });
      }
      const found = trackQC(soundings, arrival, DEFINITIONS.qc);
      const index = new Int32Array(found.length);
      const flag = new Uint8Array(found.length);
      found.forEach(([i, f], k) => {
        index[k] = i;
        flag[k] = FLAG_NAMES.indexOf(f);
      });
      parentPort!.postMessage({ id, index, flag }, [index.buffer, flag.buffer]);
    } catch (err) {
      parentPort!.postMessage({ id, error: String(err) });
    }
  },
);
