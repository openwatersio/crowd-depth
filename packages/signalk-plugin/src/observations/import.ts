import { Readable, addAbortSignal } from "node:stream";
import { Temporal } from "@js-temporal/polyfill";
import type { BathymetrySource, Timeframe } from "../types.js";
import type { createObservationStore } from "./client.js";
import {
  CHUNK_POINTS,
  MAX_IMPORT_POINTS,
  type Acquisition,
  type Observation,
} from "./store.js";

/** Persist each acquired batch before exposing it; publish completeness only at EOF.
 * Cancelling leaves lossless chunks available, but never a false completion receipt. */
export async function* importObservations(
  store: ReturnType<typeof createObservationStore>,
  source: BathymetrySource,
  acquisition: Acquisition,
  identity: string,
  window: Timeframe,
  signal: AbortSignal,
): AsyncGenerator<Observation> {
  if (!source.createObservationReader)
    throw new Error("Source cannot supply uncorrected observations");
  signal.throwIfAborted();
  const timeout = AbortSignal.timeout(30000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  let late = false;
  const request = Promise.resolve().then(() =>
    source.createObservationReader!(window),
  );
  // Providers need not support cancellation. A late result must not retain a stream.
  void request.then(
    (reader) => {
      if (late) reader?.destroy();
    },
    () => {},
  );
  let abort!: () => void;
  let reader: Readable | undefined;
  try {
    reader = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        abort = () => reject(requestSignal.reason);
        requestSignal.addEventListener("abort", abort, { once: true });
        if (requestSignal.aborted) abort();
      }),
    ]);
  } catch (error) {
    late = true;
    throw error;
  } finally {
    requestSignal.removeEventListener("abort", abort);
  }
  if (signal.aborted) {
    reader?.destroy();
    signal.throwIfAborted();
  }
  const chunks: number[] = [];
  let points: Observation[] = [],
    seen = 0;
  try {
    if (reader) {
      addAbortSignal(signal, reader);
      for await (const point of reader as AsyncIterable<Observation>) {
        signal.throwIfAborted();
        if (++seen > MAX_IMPORT_POINTS)
          throw new Error("Observation import window exceeds 100,000 samples");
        const time = Temporal.Instant.from(point.timestamp);
        if (
          Temporal.Instant.compare(time, window.from) < 0 ||
          Temporal.Instant.compare(time, window.to) >= 0
        )
          continue;
        points.push(point);
        if (points.length === CHUNK_POINTS) {
          const saved = await store.append(acquisition, points);
          chunks.push(saved.id);
          for (const p of points) {
            signal.throwIfAborted();
            yield p;
          }
          points = [];
        }
      }
    }
    if (points.length) {
      signal.throwIfAborted();
      chunks.push((await store.append(acquisition, points)).id);
      for (const p of points) {
        signal.throwIfAborted();
        yield p;
      }
    }
    signal.throwIfAborted();
    await store.publishImport(
      identity,
      window.from.epochMilliseconds,
      window.to.epochMilliseconds,
      chunks,
    );
  } finally {
    reader?.destroy();
  }
}
