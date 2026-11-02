import { submitGeoJSON, describeSubmissionError } from "./noaa.js";
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
  signal,
  schedule = BATHY_DEFAULT_SCHEDULE,
  url = BATHY_URL,
}: ReporterOptions) {
  const reportLog = createReportLogger(db);
  let running = false;
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

  async function report(timeframe = unreported()) {
    // An empty window, as when reports run less than BATHY_REPORT_DELAY apart
    // and the last one already reached past this one's end.
    if (Temporal.Instant.compare(timeframe.from, timeframe.to) >= 0) {
      app.debug(`Nothing to report from ${timeframe.from} to ${timeframe.to}`);
      return;
    }
    app.debug(`Generating report from ${timeframe.from} to ${timeframe.to}`);
    try {
      const data = await source.createReader(timeframe);
      if (!data) {
        app.debug(
          "No data to report from %s to %s",
          timeframe.from,
          timeframe.to,
        );
        checkpoint(timeframe);
        return;
      }

      const vessel = await getVesselInfo(app);
      app.debug(
        `Reporting data from ${vessel.name} (${vessel.mmsi}) to ${url}`,
      );

      const submission = await submitGeoJSON(url, config, vessel, data);
      app.debug("Submission response: %j", submission);
      checkpoint(timeframe);
    } catch (err) {
      throw status.error(
        new Error(
          `Failed to report to ${url}: ${describeSubmissionError(err)}`,
          {
            cause: err,
          },
        ),
      );
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
    const windows = await source.getAvailableTimeframes(timeframe, windowSize);
    if (signal.aborted) return;

    for (const window of windows) {
      // Stop if plugin is stopped
      if (signal.aborted) return;

      await report(window.clamp(timeframe));
    }

    // getAvailableTimeframes intentionally omits empty windows. Once the
    // complete range has been inspected, advance past those windows too so a
    // future run does not rescan an ever-growing history range.
    if (
      !reportLog.lastReport ||
      Temporal.Instant.compare(reportLog.lastReport, timeframe.to) < 0
    ) {
      checkpoint(timeframe);
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

  async function sync() {
    if (signal.aborted || running) return;
    running = true;
    clearTimeout(retry);
    retryAt = undefined;
    try {
      await reportInBatches();
    } catch (err) {
      if (!signal.aborted) {
        status.error(err as Error);
        retryAt = Temporal.Now.instant().add({ minutes: 5 });
        retry = setTimeout(() => void sync(), 5 * 60_000);
      }
    } finally {
      running = false;
      if (!signal.aborted) updateStatus();
    }
  }

  function stop() {
    app.debug(`Stopping reporter`);
    job.stop();
    clearTimeout(retry);
  }

  function start() {
    if (signal.aborted) return;
    job.start();
    updateStatus();
  }

  if (
    reportLog.lastReport &&
    // Last report was within window size
    reportLog.lastReport.epochMilliseconds >
      Temporal.Now.instant().subtract(BATHY_WINDOW_SIZE).epochMilliseconds
  ) {
    start();
  } else {
    void sync().then(start);
  }

  return { report, reportInBatches };
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
