export const NODE_ENV = process.env.VITEST
  ? "test"
  : process.env.NODE_ENV || "development";

export const {
  BATHY_URL = NODE_ENV === "production"
    ? "https://depth.openwaters.io"
    : "http://localhost:3001",
  BATHY_DEFAULT_SCHEDULE = "0 0 * * *", // every day at midnight
} = process.env;
