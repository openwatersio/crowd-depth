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

  async function report({
    from = reportLog.lastReport ?? BATHY_EPOCH,
    to = Temporal.Now.instant(),
  } = {}) {
    app.debug(`Generating report from ${from} to ${to}`);
    try {
      const data = await source.createReader({ from, to });
      if (!data) {
        app.debug("No data to report from %s to %s", from, to);
        return;
      }

      const vessel = await getVesselInfo(app);
      app.debug(
        `Reporting data from ${vessel.name} (${vessel.mmsi}) to ${url}`,
      );

      const submission = await submitGeoJSON(url, config, vessel, data);
      app.debug("Submission response: %j", submission);
      app.setPluginStatus(`Reported at ${to}`);
      reportLog.logReport({ from, to });
    } catch (err) {
      console.error(err);
      app.error(`Failed to generate or submit report: ${err}`);
      app.setPluginStatus(
        `Failed to report at ${to}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async function reportBackHistory({
    from = reportLog.lastReport ?? BATHY_EPOCH,
    to = Temporal.Now.instant(),
  } = {}) {
    if (!source.getAvailableDates) return;

    for (const date of await source.getAvailableDates({ from, to })) {
      const from = date;
      const to = date.toZonedDateTimeISO("UTC").add({ days: 1 }).toInstant();

      app.debug(`Reporting back history date ${from} to ${to}`);
      await report({ from, to });
    }
  }

  function stop() {
    app.debug(`Stopping reporter`);
    job.stop();
  }

  if (
    reportLog.lastReport &&
    // Last report was within 24 hours
    reportLog.lastReport > Temporal.Now.instant().subtract({ hours: 24 })
  ) {
    job.start();
    app.debug(`Reporting to %s with schedule: %s`, url, schedule);
    const nextReport = Temporal.Instant.fromEpochMilliseconds(
      job.nextDate().toMillis(),
    );
    app.debug(
      `Last report at ${reportLog.lastReport}, next report at ${nextReport}`,
    );
    app.setPluginStatus(`Next report at ${nextReport}`);
  } else {
    app.debug(
      "Last reported %, reporting back history",
      reportLog.lastReport ?? "never",
    );
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
