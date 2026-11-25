import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerAPI } from "@signalk/server-api";
import type { Config } from "../config.js";
import { createLiveStream } from "../streams/live.js";
import { createObservationStore } from "./client.js";
import { CHUNK_POINTS, type Acquisition, type Observation } from "./store.js";

/** Seal at most ten seconds of live samples per durable transaction. */
export function observationWriter(
  store: ReturnType<typeof createObservationStore>,
  acquisition: Acquisition,
  committed: () => void = () => {},
) {
  let points: Observation[] = [];
  let active = Promise.resolve();
  let failure: Error | undefined;
  let outstanding = 0;
  const flush = () => {
    if (!points.length) return active;
    const batch = points;
    const batchId = randomUUID();
    points = [];
    outstanding++;
    active = active
      .then(async () => {
        const deadline = Date.now() + 30000;
        for (;;) {
          try {
            await store.append(acquisition, batch, batchId);
            committed();
            break;
          } catch (error) {
            if (
              Date.now() >= deadline ||
              !/database is locked|database table is locked|disk I\/O error|database or disk is full/.test(
                String(error),
              )
            )
              throw error;
            await sleep(250);
          }
        }
      })
      .finally(() => {
        outstanding--;
      });
    void active.catch((error) => {
      failure = error;
      writer.destroy(error);
    });
    return active;
  };
  const writer = new Writable({
    objectMode: true,
    write(point: Observation, _encoding, callback) {
      if (failure) {
        callback(failure);
        return;
      }
      points.push(point);
      if (points.length >= CHUNK_POINTS)
        flush().then(() => callback(), callback);
      else callback();
    },
    final(callback) {
      flush().then(() => callback(), callback);
    },
    destroy(error, callback) {
      clearInterval(timer);
      // Abort stops subscriptions but still commits the observations already accepted.
      flush().then(
        () => callback(error),
        (failure) => callback(failure),
      );
    },
  });
  const timer = setInterval(() => {
    if (!outstanding) void flush();
  }, 10000);
  timer.unref();
  return writer;
}

export async function collectObservations(
  app: ServerAPI,
  config: Config,
  file: string,
  signal: AbortSignal,
  committed: () => void = () => {},
) {
  const store = createObservationStore(file);
  try {
    await store.ready;
    if (signal.aborted) return;
    const writer = observationWriter(
      store,
      {
        kind: "live",
        depthPath: `environment.depth.${config.path}`,
        settings: {
          sounder: config.sounder,
          gnss: config.gnss,
          path: config.path,
          positionOrigin: config.positionOrigin,
        },
      },
      committed,
    );
    const input = createLiveStream(app, config, true);
    const stop = () => input.stopCapture();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      await pipeline(input, writer);
    } finally {
      signal.removeEventListener("abort", stop);
    }
  } finally {
    await store.close();
  }
}
