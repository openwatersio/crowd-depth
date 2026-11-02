import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  createReporter,
  createReportLogger,
} from "../../src/reporters/index.js";
import { createDB } from "../../src/storage.js";
import { createStatus } from "../../src/status.js";
import { Timeframe, type BathymetrySource } from "../../src/types.js";
import { app, config, vessel } from "../helper.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BATHY_REPORT_TIMEOUT } from "../../src/constants.js";

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(
  source: BathymetrySource,
  recent = true,
  schedule = "0 0 * * *",
  server = app,
) {
  const db = createDB(":memory:");
  const logger = createReportLogger(db);
  const last = Temporal.Instant.from("2026-01-01T23:00:00Z");
  if (recent)
    logger.logReport(new Timeframe(last.subtract({ hours: 1 }), last));
  const controller = new AbortController();
  controllers.push(controller);
  const status = createStatus(server);
  const reporter = createReporter({
    app: server,
    config,
    source,
    db,
    status,
    signal: controller.signal,
    schedule,
  });
  return { logger, controller, status, last, reporter };
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

test("a normal cron report reads the whole range without an availability scan", async () => {
  const reads: Timeframe[] = [];
  let scans = 0;
  const { last } = setup({
    createReader: (timeframe) => {
      reads.push(timeframe);
      return undefined;
    },
    getAvailableTimeframes: () => {
      scans++;
      return [];
    },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(scans).toBe(0);
  expect(reads).toHaveLength(1);
  expect(reads[0]!.from).toEqual(last);
  expect(reads[0]!.to.toString()).toBe("2026-01-01T23:55:00Z");
});

test("a weekly schedule batches its backlog before reading large reports", async () => {
  const reads: Timeframe[] = [];
  let scans = 0;
  const { last } = setup(
    {
      createReader: (timeframe) => {
        reads.push(timeframe);
        return undefined;
      },
      getAvailableTimeframes: (timeframe) => {
        scans++;
        const windows: Timeframe[] = [];
        for (
          let from = timeframe.from;
          Temporal.Instant.compare(from, timeframe.to) < 0;
          from = from.add({ hours: 6 })
        )
          windows.push(
            new Timeframe(from, from.add({ hours: 6 })).clamp(timeframe),
          );
        return windows;
      },
    },
    true,
    "0 0 * * 0",
  );
  await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000);
  expect(scans).toBe(1);
  expect(reads).toHaveLength(9);
  expect(reads[0]!.from).toEqual(last);
  expect(reads.at(-1)!.to.toString()).toBe("2026-01-03T23:55:00Z");
  for (let i = 1; i < reads.length; i++)
    expect(reads[i]!.from).toEqual(reads[i - 1]!.to);
  expect(
    reads.every((timeframe) => timeframe.duration.total("hours") <= 6),
  ).toBe(true);
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
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  finish([]);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(scans).toBe(1);
  expect(status.state.nextReport).toBeUndefined();
});

test("does not overlap scheduled reports while one is still running", async () => {
  let finish!: () => void;
  let reads = 0;
  setup(
    {
      createReader: () => {
        reads++;
        return new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        });
      },
      getAvailableTimeframes: async (timeframe) => [timeframe],
    },
    true,
    "* * * * * *",
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
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

test("recovers after a history query hangs and discards its late result", async () => {
  let finish!: (data: Readable) => void;
  let reads = 0;
  const { logger, last } = setup({
    createReader: () => {
      reads++;
      return reads === 1
        ? new Promise<Readable>((resolve) => {
            finish = resolve;
          })
        : undefined;
    },
    getAvailableTimeframes: async (timeframe) => [timeframe],
  });
  await vi.advanceTimersByTimeAsync(1000 + BATHY_REPORT_TIMEOUT);
  expect(logger.lastReport).toEqual(last);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(reads).toBe(2);
  const recovered = logger.lastReport;
  const stale = Readable.from([]);
  finish(stale);
  await vi.advanceTimersByTimeAsync(0);
  expect(stale.destroyed).toBe(true);
  expect(logger.lastReport).toEqual(recovered);
});

test("a stalled startup scan times out and retries without restarting the plugin", async () => {
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  let scans = 0;
  const { logger } = setup(
    {
      createReader: () => undefined,
      getAvailableTimeframes: () => {
        scans++;
        return scans === 1 ? new Promise<Timeframe[]>(() => {}) : [];
      },
    },
    false,
  );
  await vi.advanceTimersByTimeAsync(BATHY_REPORT_TIMEOUT);
  expect(logger.lastReport).toBeUndefined();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(scans).toBeGreaterThan(1);
  expect(logger.lastReport).toBeDefined();
});

test("keeps the error visible while updating retry status and logs it once", async () => {
  let offline = true;
  const errors: string[] = [];
  let visible = "";
  vi.spyOn(app, "error").mockImplementation((err) => {
    errors.push(String(err));
  });
  vi.spyOn(app, "setPluginError").mockImplementation((message) => {
    visible = `error: ${message}`;
  });
  vi.spyOn(app, "setPluginStatus").mockImplementation((message) => {
    visible = `ok: ${message}`;
  });
  setup({
    createReader: () => {
      if (offline) throw new Error("offline");
      return undefined;
    },
    getAvailableTimeframes: async (timeframe) => [timeframe],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(errors).toHaveLength(1);
  expect(visible).toContain("error:");
  expect(visible).toContain("offline");
  expect(visible).toContain("2026-01-02T00:05:00Z");
  offline = false;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(visible).toMatch(/^ok:/);
  expect(errors).toHaveLength(1);
});

test("reporter recovery preserves an unrelated collector failure", async () => {
  let visible = "";
  vi.spyOn(app, "setPluginError").mockImplementation((message) => {
    visible = `error: ${message}`;
  });
  vi.spyOn(app, "setPluginStatus").mockImplementation((message) => {
    visible = `ok: ${message}`;
  });
  const { status } = setup({
    createReader: () => undefined,
    getAvailableTimeframes: async (timeframe) => [timeframe],
  });
  status.error(new Error("Collector stopped"), "collector");
  await vi.advanceTimersByTimeAsync(1000);
  expect(visible).toContain("error:");
  expect(visible).toContain("Collector stopped");
});

test("a non-Error history rejection remains visible in status", async () => {
  let visible = "";
  vi.spyOn(app, "setPluginError").mockImplementation((message) => {
    visible = message;
  });
  setup(
    {
      createReader: () => undefined,
      getAvailableTimeframes: () => Promise.reject("history unavailable"),
    },
    false,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(visible).toContain("history unavailable");
  expect(visible).not.toContain("undefined");
});

test("a failed middle batch resumes after the last successful window", async () => {
  let offline = true;
  const reads: string[] = [];
  const from = Temporal.Instant.from("2026-01-01T23:00:00Z");
  const windows = [0, 15, 30].map(
    (minutes) =>
      new Timeframe(from.add({ minutes }), from.add({ minutes: minutes + 15 })),
  );
  const { reporter, logger } = setup({
    createReader: (timeframe) => {
      reads.push(timeframe.from.toString());
      if (offline && timeframe.from.equals(windows[1]!.from))
        throw new Error("offline");
      return undefined;
    },
    getAvailableTimeframes: (timeframe) =>
      windows.filter(
        (window) => Temporal.Instant.compare(window.to, timeframe.from) > 0,
      ),
  });
  await expect(
    reporter.reportInBatches(new Timeframe(from, windows[2]!.to)),
  ).rejects.toThrow("offline");
  expect(logger.lastReport).toEqual(windows[0]!.to);
  offline = false;
  await reporter.reportInBatches(
    new Timeframe(logger.lastReport!, windows[2]!.to),
  );
  expect(reads).toEqual([
    "2026-01-01T23:00:00Z",
    "2026-01-01T23:15:00Z",
    "2026-01-01T23:15:00Z",
    "2026-01-01T23:30:00Z",
  ]);
  expect(logger.lastReport).toEqual(windows[2]!.to);
});

test("allows history reads to finish after five minutes", async () => {
  let finish!: () => void;
  const { logger, last } = setup({
    createReader: () =>
      new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined);
      }),
    getAvailableTimeframes: async (timeframe) => [timeframe],
  });
  await vi.advanceTimersByTimeAsync(1000 + 6 * 60_000);
  expect(logger.lastReport).toEqual(last);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(logger.lastReport).not.toEqual(last);
});

test.each([
  { stage: "identify", code: 503, expected: 2, edge: false },
  { stage: "identify", code: 0, expected: 2, edge: false },
  { stage: "upload", code: 400, expected: 2, edge: false },
  { stage: "upload", code: 401, expected: 1, edge: false },
  { stage: "upload", code: 413, expected: 1, edge: false },
  { stage: "upload", code: 426, expected: 1, edge: false },
  { stage: "upload", code: 403, expected: 1, edge: false },
  { stage: "upload", code: 503, expected: 2, edge: false },
  { stage: "upload", code: 0, expected: 1, edge: false },
  { stage: "upload", code: 403, expected: 2, edge: true },
  { stage: "upload", code: 404, expected: 2, edge: true },
  { stage: "upload", code: 413, expected: 1, edge: true },
  { stage: "upload", code: 408, expected: 2, edge: false },
  { stage: "upload", code: 429, expected: 2, edge: false },
])(
  "reporter handles $stage HTTP $code through the network path",
  async ({ stage, code, expected, edge }) => {
    const dir = await mkdtemp(join(tmpdir(), "reporter-http-"));
    if (stage === "upload")
      await writeFile(join(dir, "identity.json"), JSON.stringify(vessel));
    let requests = 0;
    let reads = 0;
    let aborted = 0;
    vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => {
      requests++;
      if (code)
        return Promise.resolve(
          new Response(
            edge
              ? "<html>Temporarily unavailable</html>"
              : JSON.stringify({ success: false, message: "Rejected" }),
            { status: code },
          ),
        );
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(init.signal!.reason);
          },
          { once: true },
        );
      });
    });
    const server = {
      ...app,
      getDataDirPath: () => dir,
      config: {},
      getSelfPath: () => undefined,
    };
    const { logger, last, controller, status } = setup(
      {
        createReader: () => {
          reads++;
          return Readable.from([]);
        },
        getAvailableTimeframes: async (timeframe) => [timeframe],
      },
      true,
      "0 0 * * *",
      server,
    );
    try {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(requests).toBe(1));
      if (!code) {
        await vi.advanceTimersByTimeAsync(BATHY_REPORT_TIMEOUT);
        expect(aborted).toBe(stage === "identify" ? 1 : 0);
      }
      if (code || stage === "identify")
        await vi.waitFor(() =>
          expect(status.state.nextReport!.epochMilliseconds).toBeGreaterThan(
            Date.now(),
          ),
        );
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(reads).toBe(expected);
      await vi.waitFor(() => expect(requests).toBe(expected));
      expect(logger.lastReport).toEqual(last);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      if (!code) expect(aborted).toBe(stage === "identify" ? 2 : 1);
    } finally {
      controller.abort();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("checkpoints completed availability spans before a later span fails", async () => {
  const scans: Timeframe[] = [];
  const { reporter, logger } = setup({
    createReader: () => undefined,
    getAvailableTimeframes: async (timeframe) => {
      scans.push(timeframe);
      if (scans.length === 2) throw new Error("history unavailable");
      return [];
    },
  });
  const from = Temporal.Instant.from("2026-01-02T00:00:00Z");
  await expect(
    reporter.reportInBatches(
      new Timeframe(from, from.add({ hours: 3 * 365 * 24 })),
    ),
  ).rejects.toThrow("history unavailable");
  expect(scans).toHaveLength(2);
  expect(scans[0]!.duration.total("hours")).toBe(365 * 24);
  expect(scans[1]!.from).toEqual(scans[0]!.to);
  expect(logger.lastReport).toEqual(scans[0]!.to);
});

test("aborting the last batch cannot checkpoint the final span", async () => {
  let stop!: () => void;
  const { reporter, logger, last, controller } = setup({
    createReader: () => {
      stop();
      return undefined;
    },
    getAvailableTimeframes: (timeframe) => [timeframe],
  });
  stop = () => controller.abort();
  await reporter.reportInBatches(
    new Timeframe(last, last.add({ minutes: 30 })),
  );
  expect(logger.lastReport).toEqual(last);
});
