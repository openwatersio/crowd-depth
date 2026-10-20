import { Worker } from "node:worker_threads";
import type { Flag, Sounding } from "../qc.js";

export const FLAG_NAMES: Flag[1][] = [
  "reject",
  "review",
  "unconfirmed",
  "noisy",
];

/** Track QC run somewhere: on a thread of its own live, in turn during a backfill. */
export type QCRunner = (
  soundings: Sounding[],
  arrival: number,
) => Promise<[index: number, flag: Flag[1]][]>;

/**
 * Track QC on a worker thread. The live writer reruns it over its whole buffer, tens of
 * thousands of soundings at anchor, so on the server's main thread it would hold the
 * server up for a quarter of a second on a Pi. The soundings go over packed as numbers,
 * which costs this thread a millisecond or two.
 */
export function createQCThread() {
  let worker: Worker | undefined;
  let closed = false;
  let next = 0;
  const waiting = new Map<
    number,
    {
      resolve: (found: [number, Flag[1]][]) => void;
      reject: (e: Error) => void;
    }
  >();
  const fail = (err: Error) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
    worker = undefined;
  };
  const start = () => {
    worker = new Worker(new URL("./qc-worker.js", import.meta.url));
    worker.unref();
    worker.on(
      "message",
      ({
        id,
        index,
        flag,
        error,
      }: {
        id: number;
        index?: Int32Array;
        flag?: Uint8Array;
        error?: string;
      }) => {
        const w = waiting.get(id);
        waiting.delete(id);
        if (error || !index || !flag) {
          w?.reject(new Error(error ?? "no result"));
          return;
        }
        w?.resolve(Array.from(index, (i, k) => [i, FLAG_NAMES[flag[k]]]));
      },
    );
    worker.on("error", (err) => fail(err as Error));
    worker.on("exit", (code) => fail(new Error(`QC worker exited (${code})`)));
  };
  const run: QCRunner = (soundings, arrival) => {
    if (closed) return Promise.reject(new Error("QC worker closed"));
    if (!worker) start();
    const data = new Float64Array(soundings.length * 4);
    soundings.forEach((s, i) => {
      data[i * 4] = s.time;
      data[i * 4 + 1] = s.lon;
      data[i * 4 + 2] = s.lat;
      data[i * 4 + 3] = s.depth;
    });
    const id = next++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker!.postMessage({ id, data, arrival }, [data.buffer]);
    });
  };
  return {
    run,
    close() {
      closed = true;
      void worker?.terminate();
      fail(new Error("QC worker closed"));
    },
  };
}
