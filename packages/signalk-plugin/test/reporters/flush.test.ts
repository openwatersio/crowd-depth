import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { Readable } from "node:stream";
import {
  createReporter,
  createReportLogger,
} from "../../src/reporters/index.js";
import { createDB } from "../../src/storage.js";
import { createStatus } from "../../src/status.js";
import { Timeframe, type BathymetrySource } from "../../src/types.js";
import { app, config, vessel } from "../helper.js";

const submit = vi.hoisted(() => vi.fn());
vi.mock("../../src/reporters/noaa.js", async (original) => ({
  ...(await original<typeof import("../../src/reporters/noaa.js")>()),
  submitGeoJSON: submit,
}));
vi.mock("../../src/metadata.js", () => ({ getVesselInfo: async () => vessel }));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00.500Z"));
  submit.mockReset();
  submit.mockResolvedValue({});
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});

function setup(source?: BathymetrySource, recent = true) {
  const db = createDB(":memory:");
  const controller = new AbortController();
  cleanups.push(() => {
    controller.abort();
    db.close();
  });
  const log = createReportLogger(db);
  const last = Temporal.Instant.from("2026-01-01T11:00:00Z");
  if (recent) log.logReport(new Timeframe(last.subtract({ hours: 1 }), last));
  const reads: Timeframe[] = [];
  const reporter = createReporter({
    app,
    config,
    db,
    status: createStatus(app),
    signal: controller.signal,
    source: source ?? {
      createReader: (span) => {
        reads.push(span);
        return Readable.from([]);
      },
      getAvailableTimeframes: (span) => [span],
    },
  });
  return { reporter, controller, log, reads, last };
}

test("flush uses old settings through the last complete second and stops scheduled reports", async () => {
  const { reporter, log, reads } = setup();
  const flushing = reporter.flush();
  expect(reporter.flush()).toBe(flushing);
  await flushing;
  expect(reads).toHaveLength(1);
  expect(reads[0].to.toString()).toBe("2026-01-01T12:00:00Z");
  expect(submit.mock.calls[0][1]).toBe(config);
  expect(log.lastReport).toEqual(reads[0].to);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(submit).toHaveBeenCalledTimes(1);
});

test("failed flush leaves its checkpoint and schedules no retry", async () => {
  submit.mockRejectedValue(new Error("offline"));
  const { reporter, log, last } = setup();
  await expect(reporter.flush()).rejects.toThrow("offline");
  expect(log.lastReport).toEqual(last);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(submit).toHaveBeenCalledTimes(1);
});

test("a hung upload cannot delay stop beyond 15 seconds or advance a checkpoint later", async () => {
  let complete!: () => void;
  submit.mockReturnValue(
    new Promise<void>((resolve) => {
      complete = resolve;
    }),
  );
  const { reporter, log, last } = setup();
  const flushing = reporter.flush();
  const rejected = expect(flushing).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(log.lastReport).toEqual(last);
  expect(submit.mock.calls[0][4].aborted).toBe(true);
  complete();
  await vi.advanceTimersByTimeAsync(0);
  expect(log.lastReport).toEqual(last);
});

test("flush waits for an existing catch-up instead of uploading concurrently", async () => {
  let finish!: () => void;
  let first = true;
  let busy = 0;
  let maxBusy = 0;
  const reads: Timeframe[] = [];
  submit.mockImplementation(async () => {
    busy++;
    maxBusy = Math.max(maxBusy, busy);
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    busy--;
  });
  const { reporter, log } = setup(
    {
      createReader: (span) => {
        reads.push(span);
        return Readable.from([]);
      },
      getAvailableTimeframes: (span) => [span],
    },
    false,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(submit).toHaveBeenCalledTimes(1);
  const flushing = reporter.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(submit).toHaveBeenCalledTimes(1);
  finish();
  await flushing;
  expect(maxBusy).toBe(1);
  expect(reads.at(-1)?.to.toString()).toBe("2026-01-01T12:00:00Z");
  expect(log.lastReport).toEqual(reads.at(-1)?.to);
});

test("a stuck history query times out and its late stream is destroyed", async () => {
  let resolve!: (stream: Readable) => void;
  const { reporter, log, last } = setup({
    createReader: () =>
      new Promise<Readable>((r) => {
        resolve = r;
      }),
    getAvailableTimeframes: () => [],
  });
  const rejected = expect(reporter.flush()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  const late = Readable.from([]);
  resolve(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(late.destroyed).toBe(true);
  expect(log.lastReport).toEqual(last);
  expect(submit).not.toHaveBeenCalled();
});

test("the timeout includes an already active catch-up upload", async () => {
  submit.mockReturnValue(new Promise(() => {}));
  const { reporter, log } = setup(undefined, false);
  await vi.advanceTimersByTimeAsync(0);
  expect(submit).toHaveBeenCalledTimes(1);
  const rejected = expect(reporter.flush()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(submit).toHaveBeenCalledTimes(1);
  expect(log.lastReport).toBeUndefined();
});

test("privacy cancellation prevents a pending history read from uploading", async () => {
  let resolve!: (stream: Readable) => void;
  const { reporter, controller, log, last } = setup({
    createReader: () =>
      new Promise<Readable>((r) => {
        resolve = r;
      }),
    getAvailableTimeframes: () => [],
  });
  const rejected = expect(reporter.flush()).rejects.toBe("Sharing disabled");
  await vi.advanceTimersByTimeAsync(0);
  controller.abort("Sharing disabled");
  await rejected;
  resolve(Readable.from([]));
  await vi.advanceTimersByTimeAsync(0);
  expect(submit).not.toHaveBeenCalled();
  expect(log.lastReport).toEqual(last);
});
