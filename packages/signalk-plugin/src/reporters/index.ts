import { submitGeoJSON } from "./noaa.js";
import { Config } from "../config.js";
import { ServerAPI } from "@signalk/server-api";
import { CronJob } from "cron";
import { getVesselInfo } from "../metadata.js";
import { BathymetrySource, Timeframe } from "../types.js";
import { BATHY_URL, BATHY_DEFAULT_SCHEDULE } from "../constants.js";
import type { Database } from "better-sqlite3";

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

  async function report({
    from = reportLog.lastReport ?? new Date(0),
    to = new Date(),
  } = {}) {
    app.debug(
      `Generating report from ${from.toISOString()} to ${to.toISOString()}`,
    );
    try {
      const data = await source.createReader({ from, to });
      if (!data) {
        app.debug(
          "No data to report from %s to %s",
          from.toISOString(),
          to.toISOString(),
        );
        return;
      }

      const vessel = await getVesselInfo(app);
      app.debug(
        `Reporting data from ${vessel.name} (${vessel.mmsi}) to ${url}`,
      );

      const submission = await submitGeoJSON(url, config, vessel, data);
      app.debug("Submission response: %j", submission);
      app.setPluginStatus(`Reported at ${to.toISOString()}`);
      reportLog.logReport({ from, to });
    } catch (err) {
      console.error(err);
      app.error(`Failed to generate or submit report: ${err}`);
      app.setPluginStatus(
        `Failed to report at ${to.toISOString()}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async function reportBackHistory() {
    if (!source.getAvailableDates) return;

    for (const date of await source.getAvailableDates()) {
      const from = new Date(date);
      const to = new Date(date);
      to.setUTCDate(to.getUTCDate() + 1);

      app.debug(
        `Reporting back history date ${from.toISOString()} to ${to.toISOString()}`,
      );
      await report({ from, to });
    }
  }

  function stop() {
    app.debug(`Stopping reporter`);
    job.stop();
  }

  if (reportLog.lastReport) {
    job.start();
    app.debug(`Reporting to %s with schedule: %s`, url, schedule);
    app.debug(
      `Last report at ${reportLog.lastReport.toISOString()}, next report at ${job.nextDate()}`,
    );
    app.setPluginStatus(`Next report at ${job.nextDate()}`);
  } else {
    app.debug("No previous report found, reporting back history");
    reportBackHistory().then(() => job.start());
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
      insert.run(from.valueOf(), to.valueOf());
    },
    get lastReport() {
      const row = select.get();
      return row ? new Date(row.toTimestamp) : undefined;
    },
  };
}
