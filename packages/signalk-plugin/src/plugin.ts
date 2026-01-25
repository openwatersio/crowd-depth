import { ServerAPI, Plugin } from "@signalk/server-api";
import { schema, Config } from "./config.js";
import { createReporter } from "./reporters/index.js";
import { createSqliteSource } from "./sources/sqlite.js";
import { ENV } from "./constants.js";
import { createHistorySource } from "./sources/history.js";
import { createDB } from "./storage.js";
import { join } from "path";
import { createCollector } from "./collector.js";
import { createStatus } from "./status.js";

export default function createPlugin(app: ServerAPI): Plugin {
  let abortController: AbortController | undefined = undefined;

  return {
    id: "crowd-depth",
    name: "Crowd Depth",
    description: "Collect and share depth data",

    async start(config: Config) {
      app.debug("Starting (ENV=%s)", ENV);
      const status = createStatus(app);

      abortController = new AbortController();
      const db = createDB(join(app.getDataDirPath(), `bathymetry.sqlite`));

      // Try to create history source.
      let source = await createHistorySource(app, config);

      if (source) {
        status.set({ usingHistory: true });
      } else {
        // No history source, fallback to sqlite.
        source = createSqliteSource(app, db);
      }

      if (source.createWriter) {
        status.set({ collecting: true });
        createCollector({
          app,
          config,
          writer: source.createWriter(),
          signal: abortController.signal,
        });
      }

      createReporter({
        app,
        config,
        source,
        db,
        status,
        signal: abortController.signal,
      });
    },

    stop() {
      abortController?.abort("Stopping crowd-depth plugin");
    },

    schema() {
      return schema(app);
    },
  };
}
