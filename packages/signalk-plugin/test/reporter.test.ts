import { describe, expect, test, vi } from "vitest";
import { createReporter, createReportLogger, Timeframe } from "../src";
import { createDB } from "../src/storage";
import { Temporal } from "@js-temporal/polyfill";
import { app, config } from "./helper";
import { createStatus } from "../src/status";
import { BATHY_REPORT_DELAY } from "../src/constants";

test("the report delay outlasts an InfluxDB write", () => {
  // signalk-to-influxdb2 by default buffers writes for up to 60 s and retries
  // a failed one for up to 180 s.
  expect(BATHY_REPORT_DELAY.total("seconds")).toBeGreaterThanOrEqual(240);
});

describe("BATHY_REPORT_DELAY", () => {
  async function load(value: string) {
    vi.stubEnv("BATHY_REPORT_DELAY", value);
    vi.resetModules();
    try {
      return (await import("../src/constants")).BATHY_REPORT_DELAY;
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  }

  test("accepts fractional seconds", async () => {
    expect((await load("1.5")).total("milliseconds")).toBe(1500);
  });

  test("rejects a negative delay", async () => {
    await expect(load("-1")).rejects.toThrow("BATHY_REPORT_DELAY");
  });

  test("rejects a delay that isn't a number", async () => {
    await expect(load("soon")).rejects.toThrow("BATHY_REPORT_DELAY");
  });
});

test("logReport", async () => {
  const logger = createReportLogger(createDB(":memory:"));
  const from = Temporal.Instant.from("2025-08-06T22:00:00.000Z");
  const to = Temporal.Instant.from("2025-08-06T23:00:00.000Z");

  expect(logger.lastReport).toBeUndefined();
  logger.logReport!({ from, to });
  expect(logger.lastReport).toEqual(to);
});

test.each(["0", "0.0004", "-1", "soon", "Infinity", "2147484"])(
  "rejects invalid report deadline %s",
  async (value) => {
    vi.stubEnv("BATHY_REPORT_TIMEOUT", value);
    vi.resetModules();
    try {
      await expect(import("../src/constants")).rejects.toThrow(
        "BATHY_REPORT_TIMEOUT",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  },
);

test.each(["0", "-1", "1.5", "soon", "Infinity"])(
  "rejects invalid reporting window %s",
  async (value) => {
    vi.stubEnv("BATHY_WINDOW_SIZE", value);
    vi.resetModules();
    try {
      await expect(import("../src/constants")).rejects.toThrow(
        "BATHY_WINDOW_SIZE",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  },
);

describe("report checkpoints", () => {
  test.each(["", " "])(
    "a blank report deadline %j uses the default without failing module load",
    async (value) => {
      vi.stubEnv("BATHY_REPORT_TIMEOUT", value);
      vi.resetModules();
      try {
        await expect(import("../src/constants")).resolves.toBeDefined();
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    },
  );

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

  test("leaves soundings still on their way to storage for the next report", async () => {
    const db = createDB(":memory:");
    const logger = createReportLogger(db);
    const now = Temporal.Now.instant();
    logger.logReport(
      new Timeframe(now.subtract({ hours: 2 }), now.subtract({ hours: 1 })),
    );
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

    // Stamped just under BATHY_REPORT_DELAY ago, and still on its way to
    // storage when the report reads.
    const stamped = Temporal.Now.instant()
      .subtract(BATHY_REPORT_DELAY)
      .add({ milliseconds: 100 });
    await reporter.report();
    const after = Temporal.Now.instant();

    // The next report starts where this one ended, so it must end before the
    // sounding to pick it up.
    expect(Temporal.Instant.compare(logger.lastReport!, stamped)).toBeLessThan(
      0,
    );
    // It ends on a whole second, since history providers bucket by the second.
    const end = logger.lastReport!.epochMilliseconds;
    expect(end % 1000).toBe(0);
    expect(end).toBeLessThanOrEqual(
      after.subtract(BATHY_REPORT_DELAY).epochMilliseconds,
    );
    abortController.abort();
  });

  test("skips a report the last report already covers", async () => {
    const db = createDB(":memory:");
    const logger = createReportLogger(db);
    const now = Temporal.Now.instant();
    logger.logReport(new Timeframe(now.subtract({ minutes: 1 }), now));
    const abortController = new AbortController();
    const status = createStatus(app);
    const reporter = createReporter({
      app,
      config,
      db,
      status,
      signal: abortController.signal,
      source: {
        createReader: async () => undefined,
        getAvailableTimeframes: async () => [],
      },
    });

    await reporter.report();

    const { count } = db
      .prepare("SELECT count(*) AS count FROM reports")
      .get() as { count: number };
    expect(count).toBe(1);
    abortController.abort();
  });

  test("skips a batch scan the last report already covers", async () => {
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

    await reporter.reportInBatches();

    expect(scanned).toBe(false);
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
