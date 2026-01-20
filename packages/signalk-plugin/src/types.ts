import { Temporal } from "@js-temporal/polyfill";
import { Readable, Writable } from "stream";

export type MaybePromise<T> = T | Promise<T>;

export type Timeframe = { from: Temporal.Instant; to: Temporal.Instant };

export type BathymetryData = {
  latitude: number;
  longitude: number;
  depth: number;
  timestamp: Temporal.Instant;
  heading?: number;
};

export interface BathymetrySource {
  createWriter?: () => Writable;
  createReader: (options: Timeframe) => MaybePromise<Readable | undefined>;
  getAvailableDates?(
    timeframe?: Partial<Timeframe>,
  ): Promise<Temporal.Instant[]>;
}
