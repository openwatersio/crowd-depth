import { Temporal } from "@js-temporal/polyfill";

const __filename = new URL(import.meta.url).pathname;
const isInstalledAsModule = __filename.includes("/node_modules/");

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
export const BATHY_URL =
  process.env.BATHY_URL ||
  (ENV === "production"
    ? "https://depth.openwaters.io"
    : "http://localhost:3001");

/** Number of hours of data to report in each submission */
export const BATHY_WINDOW_SIZE = Temporal.Duration.from({
  hours: Number(process.env.BATHY_WINDOW_SIZE ?? 6),
});

/** Cron schedule to report bathy */
export const BATHY_DEFAULT_SCHEDULE =
  process.env.BATHY_DEFAULT_SCHEDULE ?? `0 0/${BATHY_WINDOW_SIZE.hours} * * *`;

/** Earliest date for bathymetry data. signalk-to-influxdb was first released on 2017-06-28 */
export const BATHY_EPOCH = Temporal.Instant.from(
  process.env.BATHY_EPOCH ?? "2017-06-28T00:00:00Z",
);
