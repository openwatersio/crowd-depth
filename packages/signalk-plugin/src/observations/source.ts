import { setImmediate } from "node:timers/promises";
import { ObservationDataError, isObservationDataError } from "./errors.js";
import { Readable } from "node:stream";
import { Temporal } from "@js-temporal/polyfill";
import { depthReference, type Config } from "../config.js";
import { BATHY_REPORT_DELAY } from "../constants.js";
import { bowBearing } from "../streams/transforms.js";
import {
  Timeframe,
  type BathymetryData,
  type BathymetrySource,
} from "../types.js";
import type { createObservationStore } from "./client.js";
import { importObservations } from "./import.js";
import { type Acquisition, type AcquisitionStage } from "./store.js";

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
  async function acquire(window: Timeframe, preview: boolean) {
    const stage = preview ? "preview" : "full";
    const key = `${stage}:${window.from}/${window.to}`;
    if (
      requesting.has(key) ||
      [...requesting].filter((key) => key.startsWith(`${stage}:`)).length >= 2
    )
      throw new Error("Observation provider request still pending");
    requesting.add(key);
    try {
      const read = preview
        ? upstream.createObservationPreviewReader!
        : upstream.createObservationReader!;
      return await read.call(upstream, window);
    } finally {
      requesting.delete(key);
    }
  }
  const provider: BathymetrySource = {
    ...upstream,
    createObservationReader: (window) => acquire(window, false),
    ...(upstream.createObservationPreviewReader
      ? {
          createObservationPreviewReader: (window: Timeframe) =>
            acquire(window, true),
        }
      : {}),
  };
  async function* replay(
    chunks: readonly number[],
    window: Timeframe,
    readSignal: AbortSignal,
  ) {
    // The receipt is a snapshot. New imports cannot splice versions into this read.
    for (const id of chunks) {
      readSignal.throwIfAborted();
      const chunk = await store.readRange(
        id,
        window.from.epochMilliseconds,
        window.to.epochMilliseconds,
      );
      if (chunk === null) continue;
      if (!chunk)
        throw new ObservationDataError(
          `Missing published observation chunk ${id}`,
        );
      if (JSON.stringify(chunk.acquisition) !== identity)
        throw new ObservationDataError(
          `Observation chunk ${id} has incompatible acquisition settings`,
        );
      for (const point of chunk.points) {
        readSignal.throwIfAborted();
        const time = Temporal.Instant.from(point.timestamp);
        if (
          Temporal.Instant.compare(time, window.from) >= 0 &&
          Temporal.Instant.compare(time, window.to) < 0
        )
          yield point;
      }
    }
  }
  async function manifests(window: Timeframe, readSignal: AbortSignal) {
    const snapshots: {
      start: number;
      end: number;
      recorded: number;
      chunks: number[];
      stage: AcquisitionStage;
      origins?: Uint8Array;
    }[] = [];
    const start = window.from.epochMilliseconds,
      end = window.to.epochMilliseconds;
    const exact = await store.imported(identity, start, end);
    if (exact?.chunks.length) snapshots.push({ start, end, ...exact });
    let before: number | undefined;
    for (;;) {
      readSignal.throwIfAborted();
      const page = await store.importedPageInView(
        identity,
        window.from.epochMilliseconds,
        window.to.epochMilliseconds,
        [-180, -90, 180, 90],
        before,
      );
      for (const bounds of page.windows) {
        if (
          exact?.chunks.length &&
          bounds.start === start &&
          bounds.end === end
        )
          continue;
        const saved = await store.imported(identity, bounds.start, bounds.end);
        if (saved) snapshots.push({ ...bounds, ...saved });
        if (snapshots.length > 4097)
          throw new ObservationDataError("Owned window exceeds manifest limit");
      }
      if (page.before === undefined) return snapshots;
      if (before !== undefined && page.before >= before)
        throw new ObservationDataError("Owned window cursor did not advance");
      before = page.before;
      await setImmediate(undefined, { signal: readSignal });
    }
  }
  async function* replayWindow(
    window: Timeframe,
    atomic: boolean,
    readSignal: AbortSignal,
  ) {
    const snapshots = await manifests(window, readSignal);
    if (snapshots.length === 1 && !atomic) {
      yield* replay(snapshots[0].chunks, window, readSignal);
      return;
    }
    readSignal.throwIfAborted();
    const id = await store.openMergedRead(
      identity,
      snapshots,
      window.from.epochMilliseconds,
      window.to.epochMilliseconds,
    );
    try {
      for (;;) {
        readSignal.throwIfAborted();
        const { points, done } = await store.readMergedPage(id);
        for (const point of points) {
          readSignal.throwIfAborted();
          yield point;
        }
        if (done) return;
      }
    } finally {
      await store.closeMergedRead(id);
    }
  }
  async function* observations(
    window: Timeframe,
    preview: boolean,
    readSignal: AbortSignal,
  ) {
    readSignal.throwIfAborted();
    const partial = preview && !!provider.createObservationPreviewReader;
    const key = `${partial ? "preview" : "full"}:${window.from}/${window.to}`;
    const receipt = () =>
      store.imported(
        identity,
        window.from.epochMilliseconds,
        window.to.epochMilliseconds,
      );
    let saved: Awaited<ReturnType<typeof receipt>> = undefined;
    let hasOwned: boolean;
    try {
      saved = await receipt();
      hasOwned =
        !!saved?.chunks.length ||
        (await manifests(window, readSignal)).length > 0;
    } catch (error) {
      if (!isObservationDataError(error)) throw error;
      // Corrupt retained evidence must not prevent acquiring new originals.
      // Persist the acquisition first; replay still fails until the hole is repaired.
      hasOwned = true;
    }
    if (preview && hasOwned && !saved) {
      // Show retained overlap immediately, then acquire the requested window.
      // Preview consumers replace observations in place; QC emits one merged snapshot.
      try {
        yield* replayWindow(window, !preview, readSignal);
      } catch (error) {
        if (!isObservationDataError(error)) throw error;
      }
    }
    // A preview acquired before provider buffering settled never becomes QC-complete merely by aging.
    const settled = (recorded: number) =>
      recorded >= window.to.add(BATHY_REPORT_DELAY).epochMilliseconds;
    if (
      saved &&
      (preview ||
        ((saved.stage === "full" || saved.stage === "partial") &&
          saved.fresh &&
          settled(saved.recorded)))
    ) {
      try {
        yield* replayWindow(window, !preview, readSignal);
        return;
      } catch (error) {
        if (!isObservationDataError(error)) throw error;
      }
    }
    while (importing.has(key)) {
      await importing.get(key);
      readSignal.throwIfAborted();
      saved = await receipt();
      if (
        saved &&
        (preview ||
          ((saved.stage === "full" || saved.stage === "partial") &&
            saved.fresh &&
            settled(saved.recorded)))
      ) {
        try {
          yield* replayWindow(window, !preview, readSignal);
          return;
        } catch (error) {
          if (!isObservationDataError(error)) throw error;
        }
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
      const incoming = importObservations(
        store,
        provider,
        acquisition,
        identity,
        window,
        readSignal,
        partial,
      );
      if (saved || hasOwned) {
        // QC consumes the reconciled snapshot, including observations pruned upstream.
        for await (const _point of incoming) {
          /* persist incoming versions */
        }
        const reconciled = await receipt();
        if (!reconciled)
          throw new Error("Completed import has no observation receipt");
        yield* replayWindow(window, !preview, readSignal);
      } else yield* incoming;
    } finally {
      importing.delete(key);
      release();
    }
  }
  function reader(window: Timeframe, preview: boolean, original = false) {
    const controller = new AbortController();
    const readSignal = AbortSignal.any([signal, controller.signal]);
    return Readable.from(
      (async function* () {
        for await (const p of observations(window, preview, readSignal)) {
          readSignal.throwIfAborted();
          if (original) {
            yield p;
            continue;
          }
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
      {
        // Abort before Readable.from waits for its pending generator.next().
        destroy(error, callback) {
          controller.abort(error ?? new Error("Observation reader closed"));
          callback(error);
        },
      },
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
    createObservationReader: (window) => reader(window, false, true),
    createObservationPreviewReader: (window) => reader(window, true, true),
    createReader: (window) => reader(window, false),
    createPreviewReader: (window) => reader(window, true),
    getStoredTimeframes: stored,
    async getStoredTimeframePage(span, bounds, before) {
      const page = await store.importedPageInView(
        identity,
        span.from.epochMilliseconds,
        span.to.epochMilliseconds,
        bounds,
        before,
      );
      return {
        windows: page.windows.map(({ start, end }) =>
          new Timeframe(
            Temporal.Instant.fromEpochMilliseconds(start),
            Temporal.Instant.fromEpochMilliseconds(end),
          ).clamp(span),
        ),
        before: page.before,
      };
    },
    async getPreviewTimeframes(span, bounds) {
      const local = await stored(span, bounds);
      if (!upstream.getPreviewTimeframes) return local;
      const remote = await upstream.getPreviewTimeframes(span, bounds);
      const merged = new Map<string, Timeframe>();
      // Neither hint source is complete; reserve room for undiscovered visits.
      for (let i = 0; i < 64 && merged.size < 64; i++) {
        for (const window of [remote[i], local[i]]) {
          if (window && merged.size < 64)
            merged.set(`${window.from}/${window.to}`, window);
        }
      }
      return [...merged.values()];
    },
  };
}
