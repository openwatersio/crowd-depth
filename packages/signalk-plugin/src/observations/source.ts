import { Readable } from "node:stream";
import { Temporal } from "@js-temporal/polyfill";
import { depthReference, type Config } from "../config.js";
import { bowBearing } from "../streams/transforms.js";
import {
  Timeframe,
  type BathymetryData,
  type BathymetrySource,
} from "../types.js";
import type { createObservationStore } from "./client.js";
import { importObservations } from "./import.js";
import type { Acquisition } from "./store.js";

/** History is an acquisition source; published manifests own subsequent reads. */
export function storedHistorySource(
  store: ReturnType<typeof createObservationStore>,
  upstream: BathymetrySource,
  config: Config,
  signal: AbortSignal,
): BathymetrySource {
  if (!upstream.createObservationReader)
    throw new Error("History source cannot supply original observations");
  const acquisition: Acquisition = {
    kind: "history-aggregate",
    depthPath: `environment.depth.${config.path}`,
    settings: {
      sounder: config.sounder,
      gnss: config.gnss,
      path: config.path,
      positionOrigin: config.positionOrigin,
    },
  };
  const identity = JSON.stringify(acquisition);
  const offset = depthReference(config).offset;
  const importing = new Map<string, Promise<void>>();
  const requesting = new Set<string>();
  // A timed-out provider may still be running. Keep its reservation until it settles.
  const provider: BathymetrySource = {
    ...upstream,
    async createObservationReader(window) {
      const key = `${window.from}/${window.to}`;
      if (requesting.has(key) || requesting.size >= 4)
        throw new Error("Observation provider request still pending");
      requesting.add(key);
      try {
        return await upstream.createObservationReader!(window);
      } finally {
        requesting.delete(key);
      }
    },
  };
  async function* replay(chunks: readonly number[], window: Timeframe) {
    // The receipt is a snapshot. New imports cannot splice versions into this read.
    for (const id of chunks) {
      signal.throwIfAborted();
      const chunk = await store.read(id);
      if (!chunk) throw new Error(`Missing published observation chunk ${id}`);
      if (JSON.stringify(chunk.acquisition) !== identity)
        throw new Error(
          `Observation chunk ${id} has incompatible acquisition settings`,
        );
      for (const point of chunk.points) {
        signal.throwIfAborted();
        const time = Temporal.Instant.from(point.timestamp);
        if (
          Temporal.Instant.compare(time, window.from) >= 0 &&
          Temporal.Instant.compare(time, window.to) < 0
        )
          yield point;
      }
    }
  }
  async function* observations(window: Timeframe, preview: boolean) {
    signal.throwIfAborted();
    const key = `${window.from}/${window.to}`;
    const receipt = () =>
      store.imported(
        identity,
        window.from.epochMilliseconds,
        window.to.epochMilliseconds,
      );
    let saved = await receipt();
    if (saved && (preview || saved.fresh)) {
      yield* replay(saved.chunks, window);
      return;
    }
    while (importing.has(key)) {
      await importing.get(key);
      signal.throwIfAborted();
      saved = await receipt();
      if (saved?.fresh) {
        yield* replay(saved.chunks, window);
        return;
      }
    }
    let release!: () => void;
    importing.set(
      key,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      yield* importObservations(
        store,
        provider,
        acquisition,
        identity,
        window,
        signal,
      );
    } finally {
      importing.delete(key);
      release();
    }
  }
  function reader(window: Timeframe, preview: boolean) {
    return Readable.from(
      (async function* () {
        for await (const p of observations(window, preview)) {
          // Coordinates remain at their acquisition origin; chart correction runs once downstream.
          yield {
            timestamp: Temporal.Instant.from(p.timestamp),
            longitude: p.longitude,
            latitude: p.latitude,
            depth: p.depth + offset,
            heading: bowBearing({
              heading: p.headingTrue,
              courseOverGround: p.courseOverGroundTrue,
              speedOverGround: p.speedOverGround,
            }),
            gnss: p.gnss,
          } satisfies BathymetryData;
        }
      })(),
    );
  }
  const stored: NonNullable<BathymetrySource["getStoredTimeframes"]> = async (
    span,
    bounds,
  ) =>
    (
      await store.importedInView(
        identity,
        span.from.epochMilliseconds,
        span.to.epochMilliseconds,
        bounds,
      )
    ).map(({ start, end }) =>
      new Timeframe(
        Temporal.Instant.fromEpochMilliseconds(start),
        Temporal.Instant.fromEpochMilliseconds(end),
      ).clamp(span),
    );
  return {
    ...upstream,
    createObservationReader: (window) =>
      Readable.from(observations(window, false)),
    createReader: (window) => reader(window, false),
    createPreviewReader: (window) => reader(window, true),
    getStoredTimeframes: stored,
    async getPreviewTimeframes(span, bounds) {
      const local = await stored(span, bounds);
      if (local.length || !upstream.getPreviewTimeframes) return local;
      return upstream.getPreviewTimeframes(span, bounds);
    },
  };
}
