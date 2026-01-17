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

export const {
  BATHY_URL = ENV === "production"
    ? "https://depth.openwaters.io"
    : "http://localhost:3001",
  BATHY_DEFAULT_SCHEDULE = "0 0 * * *", // every day at midnight
} = process.env;
