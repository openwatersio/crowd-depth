import type { GnssQuality } from "./gnss-quality.js";
import { Temporal } from "@js-temporal/polyfill";
import { Readable, Writable } from "stream";
import type { Tide } from "./tiles/tide.js";

export type MaybePromise<T> = T | Promise<T>;

export class Timeframe {
  constructor(
    public from: Temporal.Instant,
    public to: Temporal.Instant,
  ) {}

  clamp(bounds: Timeframe): Timeframe {
    const clampedFrom =
      Temporal.Instant.compare(this.from, bounds.from) < 0
        ? bounds.from
        : this.from;
    const clampedTo =
      Temporal.Instant.compare(this.to, bounds.to) > 0 ? bounds.to : this.to;
    return new Timeframe(clampedFrom, clampedTo);
  }

  get duration(): Temporal.Duration {
    return this.to.since(this.from);
  }
}

export type BathymetryData = {
  latitude: number;
  longitude: number;
  depth: number;
  timestamp: Temporal.Instant;
  heading?: number;
  gnss?: GnssQuality;
  /** The water level above chart datum at the sounding, for the chart layer. */
  tide?: Tide;
};

export interface BathymetrySource {
  /** Uncorrected paired observations, with actual metadata when the provider supplies it. */
  createObservationReader?: (
    options: Timeframe,
  ) => MaybePromise<Readable | undefined>;
  /** Original paired observations before optional metadata acquisition; never a full receipt. */
  createObservationPreviewReader?: (
    options: Timeframe,
  ) => MaybePromise<Readable | undefined>;
  /** Bounded spatial lookup over already acquired local chunks; never calls a provider. */
  getStoredTimeframes?: (
    timeframe: Timeframe,
    bounds: readonly [number, number, number, number],
  ) => MaybePromise<Timeframe[]>;
  /** Continue bounded viewport discovery past already-processed windows. */
  getStoredTimeframePage?: (
    timeframe: Timeframe,
    bounds: readonly [number, number, number, number],
    before?: number,
  ) => MaybePromise<{ windows: Timeframe[]; before?: number }>;
  /** Optional spatial hints for preview acquisition, never a completeness claim. */
  getPreviewTimeframes?: (
    timeframe: Timeframe,
    bounds: readonly [number, number, number, number],
  ) => Promise<Timeframe[]>;
  /** Same paired/corrected samples, without optional reporting-only metadata reads. */
  createPreviewReader?: (
    options: Timeframe,
  ) => MaybePromise<Readable | undefined>;
  createWriter?: () => Writable;
  createReader: (options: Timeframe) => MaybePromise<Readable | undefined>;
  getAvailableTimeframes(
    timeframe: Timeframe,
    windowSize: Temporal.Duration,
  ): MaybePromise<Timeframe[]>;
}
