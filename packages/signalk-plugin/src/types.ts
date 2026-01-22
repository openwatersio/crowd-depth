import { Readable, Writable } from "stream";

export type MaybePromise<T> = T | Promise<T>;

export type Timeframe = { from: Date; to: Date };

export type BathymetryData = {
  latitude: number;
  longitude: number;
  depth: number;
  timestamp: Date;
  heading?: number;
};

export interface BathymetrySource {
  createWriter?: () => Writable;
  createReader: (options: Timeframe) => MaybePromise<Readable | undefined>;
  getAvailableDates?(timeframe?: Partial<Timeframe>): Promise<Date[]>;
}
