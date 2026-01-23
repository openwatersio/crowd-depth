import { submitGeoJSON } from "./noaa.js";
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
} from "../constants.js";
import type { Database } from "better-sqlite3";
import { Temporal } from "@js-temporal/polyfill";

export * from "./noaa.js";

export interface ReporterOptions {
  app: ServerAPI;
  config: Config;
  source: BathymetrySource;
  db: Database;
  signal: AbortSignal;
  schedule?: string; // cron schedule string
  url?: string; // URL of service
}

export function createReporter({
  app,
  config,
  source,
  db,
  signal,
  schedule = BATHY_DEFAULT_SCHEDULE,
  url = BATHY_URL,
}: ReporterOptions) {
  const reportLog = createReportLogger(db);
  const job = new CronJob(schedule, report);
  signal.addEventListener("abort", stop, { once: true });

  async function report(
    timeframe = new Timeframe(
      reportLog.lastReport ?? BATHY_EPOCH,
      Temporal.Now.instant(),
    ),
  ) {
    app.debug(`Generating report from ${timeframe.from} to ${timeframe.to}`);
    try {
      const data = await source.createReader(timeframe);
      if (!data) {
        app.debug(
          "No data to report from %s to %s",
          timeframe.from,
          timeframe.to,
        );
        return;
      }

      const vessel = await getVesselInfo(app);
      app.debug(
        `Reporting data from ${vessel.name} (${vessel.mmsi}) to ${url}`,
      );

      const submission = await submitGeoJSON(url, config, vessel, data);
      app.debug("Submission response: %j", submission);
      app.setPluginStatus(`Reported at ${timeframe.to}`);
      reportLog.logReport(timeframe);
    } catch (err) {
      console.error(err);
      app.error(`Failed to generate or submit report: ${err}`);
      app.setPluginStatus(
        `Failed to report at ${timeframe.to}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async function reportInBatches(
    timeframe = new Timeframe(
      reportLog.lastReport ?? BATHY_EPOCH,
      Temporal.Now.instant(),
    ),
    windowSize = BATHY_WINDOW_SIZE,
  ) {
    app.debug(
      "Last reported %s, reporting in batches",
      reportLog.lastReport ?? "never",
    );

    for (const window of await source.getAvailableTimeframes(
      timeframe,
      windowSize,
    )) {
      // Stop if plugin is stopped
      if (signal.aborted) return;

      await report(window.clamp(timeframe));
    }

    app.debug("Back history reporting complete");
  }

  function stop() {
    app.debug(`Stopping reporter`);
    job.stop();
  }

  function start() {
    job.start();

    app.debug(
      `Last report at %s, next report at %s`,
      reportLog.lastReport,
      job.nextDate(),
    );
    app.setPluginStatus(`Next report at ${job.nextDate()}`);
  }

  if (
    reportLog.lastReport &&
    // Last report was within window size
    reportLog.lastReport.epochMilliseconds >
      Temporal.Now.instant().subtract(BATHY_WINDOW_SIZE).epochMilliseconds
  ) {
    start();
  } else {
    reportInBatches().then(start);
  }
}

export function createReportLogger(db: Database) {
  const insert = db.prepare(
    `INSERT INTO reports(fromTimestamp, toTimestamp) VALUES(?, ?)`,
  );
  const select = db.prepare<[], { toTimestamp: number }>(
    `SELECT toTimestamp FROM reports ORDER BY toTimestamp DESC LIMIT 1`,
  );

  return {
    logReport({ from, to }: Timeframe) {
      insert.run(from.epochMilliseconds, to.epochMilliseconds);
    },
    get lastReport() {
      const row = select.get();
      return row
        ? Temporal.Instant.fromEpochMilliseconds(row.toTimestamp)
        : undefined;
    },
  };
}
