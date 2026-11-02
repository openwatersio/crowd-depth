import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  createReporter,
  createReportLogger,
} from "../../src/reporters/index.js";
import { createDB } from "../../src/storage.js";
import { createStatus } from "../../src/status.js";
import { Timeframe, type BathymetrySource } from "../../src/types.js";
import { app, config } from "../helper.js";

const controllers: AbortController[] = [];

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T23:59:59Z"));
});

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.abort());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup(source: BathymetrySource, recent = true) {
  const db = createDB(":memory:");
  const logger = createReportLogger(db);
  const last = Temporal.Instant.from("2026-01-01T23:00:00Z");
  if (recent)
    logger.logReport(new Timeframe(last.subtract({ hours: 1 }), last));
  const controller = new AbortController();
  controllers.push(controller);
  const status = createStatus(app);
  createReporter({
    app,
    config,
    source,
    db,
    status,
    signal: controller.signal,
    schedule: "0 0 * * *",
  });
  return { logger, controller, status, last };
}

test("retries a failed scheduled report until it recovers, then returns to cron", async () => {
  let offline = true;
  const reads: Timeframe[] = [];
  const { logger, last, status } = setup({
    createReader: async (timeframe) => {
      reads.push(timeframe);
      if (offline) throw new Error("offline");
      return undefined;
    },
    getAvailableTimeframes: async (timeframe) => [timeframe],
  });

  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(1);
  expect(logger.lastReport).toEqual(last);
  expect(status.state.nextReport?.toString()).toBe("2026-01-02T00:05:00Z");
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(reads).toHaveLength(2);
  expect(logger.lastReport).toEqual(last);

  offline = false;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(reads).toHaveLength(3);
  expect(reads[2]!.from).toEqual(last);
  expect(logger.lastReport?.toString()).toBe("2026-01-02T00:05:00Z");
  expect(status.state.nextReport?.toString()).toBe("2026-01-03T00:00:00Z");
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(reads).toHaveLength(3);
});

test("recovers from a failed startup scan and keeps the schedule running", async () => {
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  let offline = true;
  const { logger, status } = setup(
    {
      createReader: async () => undefined,
      getAvailableTimeframes: async () => {
        if (offline) throw new Error("history unavailable");
        return [];
      },
    },
    false,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(logger.lastReport).toBeUndefined();
  offline = false;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(logger.lastReport).toBeDefined();
  expect(status.state.nextReport).toBeDefined();
  const recovered = logger.lastReport!;
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(logger.lastReport!.epochMilliseconds).toBeGreaterThan(
    recovered.epochMilliseconds,
  );
});

test("stopping cancels a pending retry", async () => {
  let reads = 0;
  const { controller } = setup({
    createReader: async () => {
      reads++;
      throw new Error("offline");
    },
    getAvailableTimeframes: async (timeframe) => [timeframe],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toBe(1);
  controller.abort();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(reads).toBe(1);
});

test("a report finishing after stop cannot restart the scheduler", async () => {
  let finish!: (windows: Timeframe[]) => void;
  let scans = 0;
  const { controller, status } = setup(
    {
      createReader: async () => undefined,
      getAvailableTimeframes: () => {
        scans++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    false,
  );
  controller.abort();
  finish([]);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(scans).toBe(1);
  expect(status.state.nextReport).toBeUndefined();
});

test("does not overlap scheduled reports while one is still running", async () => {
  let finish!: () => void;
  let reads = 0;
  setup({
    createReader: () => {
      reads++;
      return new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined);
      });
    },
    getAvailableTimeframes: async (timeframe) => [timeframe],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toBe(1);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(reads).toBe(1);
  finish();
  await vi.advanceTimersByTimeAsync(0);
});

test("a failed report finishing after stop cannot schedule a retry", async () => {
  let fail!: (err: Error) => void;
  const { controller } = setup({
    createReader: () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    getAvailableTimeframes: async (timeframe) => [timeframe],
  });
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  fail(new Error("offline"));
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
