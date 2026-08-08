import { describe, expect, test } from "vitest";
import { createReporter, createReportLogger, Timeframe } from "../src";
import { createDB } from "../src/storage";
import { Temporal } from "@js-temporal/polyfill";
import { app, config } from "./helper";
import { createStatus } from "../src/status";

test("logReport", async () => {
  const logger = createReportLogger(createDB(":memory:"));
  const from = Temporal.Instant.from("2025-08-06T22:00:00.000Z");
  const to = Temporal.Instant.from("2025-08-06T23:00:00.000Z");

  expect(logger.lastReport).toBeUndefined();
  logger.logReport!({ from, to });
  expect(logger.lastReport).toEqual(to);
});

describe("report checkpoints", () => {
  test("advances after a scan finds no data", async () => {
    const db = createDB(":memory:");
    const logger = createReportLogger(db);
    const now = Temporal.Now.instant();
    logger.logReport(new Timeframe(now.subtract({ minutes: 1 }), now));
    const abortController = new AbortController();
    const reporter = createReporter({
      app,
      config,
      db,
      status: createStatus(app),
      signal: abortController.signal,
      source: {
        createReader: async () => undefined,
        getAvailableTimeframes: async () => [],
      },
    });
    const timeframe = new Timeframe(now, now.add({ hours: 6 }));

    await reporter.report(timeframe);

    expect(logger.lastReport?.epochMilliseconds).toBe(
      timeframe.to.epochMilliseconds,
    );
    abortController.abort();
  });

  test("advances past empty windows after a batch scan", async () => {
    const db = createDB(":memory:");
    const logger = createReportLogger(db);
    const now = Temporal.Now.instant();
    logger.logReport(new Timeframe(now.subtract({ minutes: 1 }), now));
    const abortController = new AbortController();
    const reporter = createReporter({
      app,
      config,
      db,
      status: createStatus(app),
      signal: abortController.signal,
      source: {
        createReader: async () => undefined,
        getAvailableTimeframes: async () => [],
      },
    });
    const timeframe = new Timeframe(now, now.add({ hours: 72 }));

    await reporter.reportInBatches(timeframe);

    expect(logger.lastReport?.epochMilliseconds).toBe(
      timeframe.to.epochMilliseconds,
    );
    abortController.abort();
  });

  test("does not advance when reading data fails", async () => {
    const db = createDB(":memory:");
    const logger = createReportLogger(db);
    const now = Temporal.Now.instant();
    logger.logReport(new Timeframe(now.subtract({ minutes: 1 }), now));
    const abortController = new AbortController();
    const reporter = createReporter({
      app,
      config,
      db,
      status: createStatus(app),
      signal: abortController.signal,
      source: {
        createReader: async () => {
          throw new Error("history unavailable");
        },
        getAvailableTimeframes: async () => [],
      },
    });

    await expect(
      reporter.report(new Timeframe(now, now.add({ hours: 6 }))),
    ).rejects.toThrow("history unavailable");
    expect(logger.lastReport?.epochMilliseconds).toBe(now.epochMilliseconds);
    abortController.abort();
  });

  test("does not advance an aborted batch scan", async () => {
    const db = createDB(":memory:");
    const logger = createReportLogger(db);
    const now = Temporal.Now.instant();
    logger.logReport(new Timeframe(now.subtract({ minutes: 1 }), now));
    const abortController = new AbortController();
    let scanned = false;
    const reporter = createReporter({
      app,
      config,
      db,
      status: createStatus(app),
      signal: abortController.signal,
      source: {
        createReader: async () => undefined,
        getAvailableTimeframes: async () => {
          scanned = true;
          return [];
        },
      },
    });
    abortController.abort();

    await reporter.reportInBatches(new Timeframe(now, now.add({ hours: 72 })));

    expect(logger.lastReport?.epochMilliseconds).toBe(now.epochMilliseconds);
    expect(scanned).toBe(false);
  });

  test("does not advance when aborted during an empty scan", async () => {
    const db = createDB(":memory:");
    const logger = createReportLogger(db);
    const now = Temporal.Now.instant();
    logger.logReport(new Timeframe(now.subtract({ minutes: 1 }), now));
    const abortController = new AbortController();
    const reporter = createReporter({
      app,
      config,
      db,
      status: createStatus(app),
      signal: abortController.signal,
      source: {
        createReader: async () => {
          abortController.abort();
          return undefined;
        },
        getAvailableTimeframes: async () => [],
      },
    });

    await reporter.report(new Timeframe(now, now.add({ hours: 6 })));

    expect(logger.lastReport?.epochMilliseconds).toBe(now.epochMilliseconds);
  });
});
