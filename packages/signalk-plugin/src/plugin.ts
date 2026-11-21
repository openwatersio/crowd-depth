import { ServerAPI, Plugin } from "@signalk/server-api";
import { schema, Config } from "./config.js";
import { createReporter } from "./reporters/index.js";
import { createSqliteSource } from "./sources/sqlite.js";
import { BATHY_HISTORY_WAIT, ENV } from "./constants.js";
import { createHistorySource } from "./sources/history.js";
import { settleSource } from "./sources/settle.js";
import { createDB } from "./storage.js";
import { join } from "path";
import { createCollector } from "./collector.js";
import { createStatus, Status } from "./status.js";
import { startChartSafely } from "./chart.js";

export default function createPlugin(app: ServerAPI): Plugin {
  let abortController: AbortController | undefined = undefined;

  return {
    id: "crowd-depth",
    name: "Crowd Depth",
    description:
      "Collect and share depth data with crowd-sourced bathymetry programs",

    start(config: Config) {
      app.debug("Starting (ENV=%s)", ENV);
      const status = createStatus(app);

      // A restart can replace abortController while the source still settles.
      const controller = new AbortController();
      abortController = controller;
      const db = createDB(join(app.getDataDirPath(), `bathymetry.sqlite`));
      const chart = startChartSafely({
        app,
        config,
        db,
        signal: controller.signal,
      });

      // Settling can wait up to BATHY_HISTORY_WAIT for a history provider, so
      // it runs in the background and start() doesn't hold up the server.
      void settleAndReport({
        app,
        config,
        db,
        chart,
        status,
        controller,
      }).catch((err: unknown) => {
        if (!controller.signal.aborted) status.error(err as Error);
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

interface SettleAndReportOptions {
  app: ServerAPI;
  config: Config;
  db: ReturnType<typeof createDB>;
  chart: ReturnType<typeof startChartSafely>;
  status: Status;
  controller: AbortController;
}

async function settleAndReport({
  app,
  config,
  db,
  chart,
  status,
  controller,
}: SettleAndReportOptions) {
  const sqlite = createSqliteSource(app, db);
  const source = await settleSource({
    findHistory: () => createHistorySource(app, config),
    sqlite,
    record: (signal) =>
      createCollector({
        app,
        config,
        writer: sqlite.createWriter!(),
        signal,
      }).catch((err: unknown) => {
        if (!signal.aborted) status.error(err as Error, "collector");
      }),
    status,
    wait: BATHY_HISTORY_WAIT,
    signal: controller.signal,
  });
  if (!source) return;

  void chart?.backfill(source);

  createReporter({
    app,
    config,
    source,
    db,
    status,
    signal: controller.signal,
  });
}
