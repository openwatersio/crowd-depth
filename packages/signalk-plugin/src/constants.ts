import { Temporal } from "@js-temporal/polyfill";

// import.meta.url is undefined on workerd; string check avoids URL parsing
const isInstalledAsModule = !!import.meta.url?.includes("/node_modules/");

/**
 * Determine the environment the application is running in.
 *
 * Priority:
 * 1. NODE_ENV variable if set
 * 2. VITEST variable if running tests
 * 3. If installed as a module, assume production
 * 4. Default to development
 */
export const ENV =
  process.env.NODE_ENV ||
  (process.env.VITEST && "test") ||
  (isInstalledAsModule && "production") ||
  "development";

/** The URL to report data to */
export const BATHY_URL = (
  process.env.BATHY_URL ||
  (ENV === "production"
    ? "https://api.openwaters.io/bathymetry"
    : "http://localhost:3001")
)
  // Trailing slash so relative URL joins keep the path prefix:
  // new URL("geojson", ".../bathymetry") would drop the last segment
  .replace(/\/?$/, "/");

/** Number of hours of data to report in each submission */
const windowHours = Number(process.env.BATHY_WINDOW_SIZE?.trim() || 6);
if (!Number.isSafeInteger(windowHours) || windowHours <= 0) {
  throw new RangeError(
    `BATHY_WINDOW_SIZE must be a positive whole number of hours, not "${process.env.BATHY_WINDOW_SIZE}"`,
  );
}
export const BATHY_WINDOW_SIZE = Temporal.Duration.from({
  hours: windowHours,
});

/**
 * How far behind now each report window ends. A sounding is stamped before it
 * reaches storage, so a window ending at now could close before the sounding
 * lands, and the next one would start after it. Live data lands a few ticks
 * later. signalk-to-influxdb2 by default buffers writes for up to 60 s and
 * retries a failed write for up to 180 s; raise this if its write options are
 * raised. A sounding that reaches storage later than this after its
 * timestamp, such as one stamped by a device with a slow clock, is never
 * reported.
 */
const reportDelay = Number(process.env.BATHY_REPORT_DELAY ?? 300);
// A negative delay would end reports in the future, past soundings not yet
// recorded, and the next report would start after them.
if (!(reportDelay >= 0)) {
  throw new RangeError(
    `BATHY_REPORT_DELAY must be a number of seconds, 0 or more, not "${process.env.BATHY_REPORT_DELAY}"`,
  );
}
export const BATHY_REPORT_DELAY = Temporal.Duration.from({
  milliseconds: Math.round(reportDelay * 1000),
});

const reportTimeout = Number(process.env.BATHY_REPORT_TIMEOUT?.trim() || 1800);
const reportTimeoutMs = Math.round(reportTimeout * 1000);
if (!(reportTimeoutMs >= 1 && reportTimeoutMs <= 2_147_483_647)) {
  throw new RangeError(
    `BATHY_REPORT_TIMEOUT must round to at least 1 ms within the Node timer limit, not "${process.env.BATHY_REPORT_TIMEOUT}"`,
  );
}
export const BATHY_REPORT_TIMEOUT = reportTimeoutMs;

/** Cron schedule to report bathy */
export const BATHY_DEFAULT_SCHEDULE =
  process.env.BATHY_DEFAULT_SCHEDULE ?? `0 0/${BATHY_WINDOW_SIZE.hours} * * *`;

/**
 * How long to wait at startup for a history provider before recording to
 * SQLite instead. Providers register when their plugin has started, which for
 * signalk-questdb means once its database container runs: seconds, or minutes
 * when the image is first pulled.
 */
export const BATHY_HISTORY_WAIT = Temporal.Duration.from({
  seconds: Number(process.env.BATHY_HISTORY_WAIT ?? 600),
});

/** Earliest date for bathymetry data. signalk-to-influxdb was first released on 2017-06-28 */
export const BATHY_EPOCH = Temporal.Instant.from(
  process.env.BATHY_EPOCH ?? "2017-06-28T00:00:00Z",
);
