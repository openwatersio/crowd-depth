import {
  submitGeoJSON,
  describeSubmissionError,
  SubmissionError,
} from "./noaa.js";
import { Readable } from "node:stream";
import { Config } from "../config.js";
import { ServerAPI } from "@signalk/server-api";
import { CronJob } from "cron";
import { getVesselInfo } from "../metadata.js";
import { BathymetrySource, Timeframe } from "../types.js";
import {
  BATHY_URL,
  BATHY_DEFAULT_SCHEDULE,
  BATHY_EPOCH,
  BATHY_WINDOW_SIZE,
  BATHY_REPORT_DELAY,
  BATHY_REPORT_TIMEOUT,
} from "../constants.js";
import type { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { Status } from "../status.js";

export * from "./noaa.js";

export interface ReporterOptions {
  app: ServerAPI;
  config: Config;
  source: BathymetrySource;
  db: DatabaseSync;
  status: Status;
  signal: AbortSignal;
  schedule?: string; // cron schedule string
  url?: string; // URL of service
}

export function createReporter({
  app,
  config,
  source,
  db,
  status,
  signal: parentSignal,
  schedule = BATHY_DEFAULT_SCHEDULE,
  url = BATHY_URL,
}: ReporterOptions) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([parentSignal, lifetime.signal]);
  const reportLog = createReportLogger(db);
  let catchingUp =
    !reportLog.lastReport ||
    reportLog.lastReport.epochMilliseconds <=
      Temporal.Now.instant().subtract(BATHY_WINDOW_SIZE).epochMilliseconds;
  let active: Promise<void> | undefined;
  let stopping = false;
  let flushing: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryAt: Temporal.Instant | undefined;
  const job = new CronJob(schedule, sync);
  signal.addEventListener("abort", stop, { once: true });

  // From the last report to a whole second BATHY_REPORT_DELAY ago. History
  // providers bucket by the second, so a window ending mid-second would split
  // a bucket across two reports.
  function unreported() {
    return new Timeframe(
      reportLog.lastReport ?? BATHY_EPOCH,
      Temporal.Now.instant()
        .subtract(BATHY_REPORT_DELAY)
        .round({ smallestUnit: "second", roundingMode: "floor" }),
    );
  }

  async function bounded<T>(
    operationName: string,
    operation: (attempt: AbortSignal) => T | Promise<T>,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `${operationName} timed out; raise BATHY_REPORT_TIMEOUT for slow storage or services`,
          ),
        ),
      BATHY_REPORT_TIMEOUT,
    );
    const attempt = AbortSignal.any([signal, controller.signal]);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(attempt.reason);
      attempt.addEventListener("abort", onAbort, { once: true });
      if (attempt.aborted) onAbort();
    });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => {
            attempt.throwIfAborted();
            return operation(attempt);
          })
          .then((value) => {
            if (attempt.aborted && value instanceof Readable) value.destroy();
            attempt.throwIfAborted();
            return value;
          }),
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
      attempt.removeEventListener("abort", onAbort);
    }
  }

  async function report(timeframe = unreported()) {
    // An empty window, as when reports run less than BATHY_REPORT_DELAY apart
    // and the last one already reached past this one's end.
    if (Temporal.Instant.compare(timeframe.from, timeframe.to) >= 0) {
      app.debug(`Nothing to report from ${timeframe.from} to ${timeframe.to}`);
      return;
    }
    app.debug(`Generating report from ${timeframe.from} to ${timeframe.to}`);
    let data: Readable | undefined;
    try {
      data = await bounded("History read", () =>
        source.createReader(timeframe),
      );
      if (!data) {
        app.debug(
          "No data to report from %s to %s",
          timeframe.from,
          timeframe.to,
        );
        checkpoint(timeframe);
        return;
      }

      const vessel = await bounded("Identity lookup", (attempt) =>
        getVesselInfo(app, attempt, config),
      );
      app.debug(
        `Reporting data from ${vessel.name} (${vessel.mmsi}) to ${url}`,
      );

      // Preserve native fetch behavior so slow transfers have no new duration cap.
      const submission = await submitGeoJSON(
        url,
        config,
        vessel,
        data,
        signal,
        BATHY_REPORT_TIMEOUT,
      );
      app.debug("Submission response: %j", submission);
      checkpoint(timeframe);
    } catch (err) {
      if (signal.aborted) return;
      const milliseconds =
        timeframe.to.epochMilliseconds - timeframe.from.epochMilliseconds;
      if (
        err instanceof SubmissionError &&
        err.status === 413 &&
        milliseconds > 1000
      ) {
        data?.destroy();
        const middle = Temporal.Instant.fromEpochMilliseconds(
          Math.floor(
            (timeframe.from.epochMilliseconds +
              timeframe.to.epochMilliseconds) /
              2000,
          ) * 1000,
        );
        if (
          Temporal.Instant.compare(middle, timeframe.from) > 0 &&
          Temporal.Instant.compare(middle, timeframe.to) < 0
        ) {
          await report(new Timeframe(timeframe.from, middle));
          await report(new Timeframe(middle, timeframe.to));
          return;
        }
      }
      throw new Error(
        `Failed to report to ${url}: ${describeSubmissionError(err)}`,
        {
          cause: err,
        },
      );
    } finally {
      data?.destroy();
    }
  }

  async function reportInBatches(
    timeframe = unreported(),
    windowSize = BATHY_WINDOW_SIZE,
  ) {
    app.debug(
      "Last reported %s, reporting in batches",
      reportLog.lastReport ?? "never",
    );

    if (signal.aborted) return;
    if (Temporal.Instant.compare(timeframe.from, timeframe.to) >= 0) {
      app.debug(`Nothing to report from ${timeframe.from} to ${timeframe.to}`);
      return;
    }
    // Bound availability scans so years of history are not one provider query.
    for (
      let from = timeframe.from;
      Temporal.Instant.compare(from, timeframe.to) < 0;
    ) {
      const next = from.add({ hours: 365 * 24 });
      const span = new Timeframe(
        from,
        Temporal.Instant.compare(next, timeframe.to) < 0 ? next : timeframe.to,
      );
      const windows = await bounded("Availability scan", () =>
        source.getAvailableTimeframes(span, windowSize),
      );
      if (signal.aborted) return;

      for (const window of windows) {
        if (signal.aborted) return;
        await report(window.clamp(span));
      }

      if (
        !reportLog.lastReport ||
        Temporal.Instant.compare(reportLog.lastReport, span.to) < 0
      )
        checkpoint(span);
      from = span.to;
    }

    app.debug("Back history reporting complete");
  }

  function checkpoint(timeframe: Timeframe) {
    if (signal.aborted) return;
    status.set({ lastReport: timeframe.to });
    reportLog.logReport(timeframe);
  }

  function updateStatus() {
    const scheduled = Temporal.Instant.fromEpochMilliseconds(
      job.nextDate().toMillis(),
    );
    status.set({
      lastReport: reportLog.lastReport,
      nextReport:
        retryAt && Temporal.Instant.compare(retryAt, scheduled) < 0
          ? retryAt
          : scheduled,
    });
  }

  function sync(): Promise<void> {
    if (signal.aborted || stopping) return Promise.resolve();
    if (!active)
      active = synchronize().finally(() => {
        active = undefined;
      });
    return active;
  }

  async function synchronize() {
    clearTimeout(retry);
    retryAt = undefined;
    try {
      const timeframe = unreported();
      if (
        catchingUp ||
        timeframe.duration.total("milliseconds") >
          BATHY_WINDOW_SIZE.total("milliseconds")
      )
        await reportInBatches(timeframe);
      else await report(timeframe);
      catchingUp = false;
      if (!signal.aborted) status.clearError("reporter");
    } catch (err) {
      catchingUp = true;
      if (!signal.aborted) {
        status.error(err as Error, "reporter");
        const cause = err instanceof Error && err.cause ? err.cause : err;
        if (
          !stopping &&
          !(cause instanceof SubmissionError && cause.permanent)
        ) {
          retryAt = Temporal.Now.instant().add({ minutes: 5 });
          retry = setTimeout(() => void sync(), 5 * 60_000);
        }
      }
    } finally {
      if (!signal.aborted && !stopping) updateStatus();
    }
  }

  function stop() {
    app.debug(`Stopping reporter`);
    job.stop();
    clearTimeout(retry);
  }

  function start() {
    if (signal.aborted || stopping) return;
    job.start();
    updateStatus();
  }

  if (catchingUp) {
    void sync().then(start);
  } else start();

  /** Best effort on stop: no buffer delay, no concurrent upload, and no retry timer. */
  function flush(): Promise<void> {
    if (flushing) return flushing;
    stopping = true;
    stop();
    const to = Temporal.Now.instant().round({
      smallestUnit: "second",
      roundingMode: "floor",
    });
    const timer = setTimeout(
      () =>
        lifetime.abort(new Error("Final report timed out after 15 seconds")),
      15_000,
    );
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    flushing = Promise.race([
      (async () => {
        await active;
        signal.throwIfAborted();
        const timeframe = new Timeframe(
          reportLog.lastReport ?? BATHY_EPOCH,
          to,
        );
        if (
          timeframe.duration.total("milliseconds") >
          BATHY_WINDOW_SIZE.total("milliseconds")
        )
          await reportInBatches(timeframe);
        else await report(timeframe);
      })(),
      aborted,
    ]).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      lifetime.abort("Reporter stopped");
    });
    return flushing;
  }

  return { report, reportInBatches, flush };
}

export function createReportLogger(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO reports(fromTimestamp, toTimestamp) VALUES(?, ?)`,
  );
  const select = db.prepare(
    `SELECT toTimestamp FROM reports ORDER BY toTimestamp DESC LIMIT 1`,
  );

  return {
    logReport({ from, to }: Timeframe) {
      insert.run(from.epochMilliseconds, to.epochMilliseconds);
    },
    get lastReport() {
      const row = select.get() as { toTimestamp: number } | undefined;
      return row
        ? Temporal.Instant.fromEpochMilliseconds(row.toTimestamp)
        : undefined;
    },
  };
}
