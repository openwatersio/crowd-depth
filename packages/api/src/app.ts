import express from "express";
import { createApi, type APIOptions } from "./api.js";

// Request logging is left to the platform: pino-http reads pino's internal
// symbols through a CJS require, which resolves to undefined on workerd.
export function createApp(options: APIOptions = {}) {
  const app = express();
  const api = createApi(options);

  app.use("/bathymetry", api);

  // Legacy vessels post to the root of depth.openwaters.io. Only the shared
  // api host reserves the root for other services.
  app.use((req, res, next) =>
    req.hostname === "api.openwaters.io" ? next() : api(req, res, next),
  );

  return app;
}

export default createApp();
