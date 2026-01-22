import pino from "pino";

const rootLogger = pino({
  name: "crowd-depth",
  level:
    process.env.LOG_LEVEL || process.env.NODE_ENV === "production"
      ? "info"
      : "debug",
});

export function getLogger(module: string) {
  return rootLogger.child({ module });
}

export default rootLogger;
