import { resolveDepthConfig } from "./depth-path.js";

import {
  recordQuality,
  recordedQuality,
  pruneQuality,
} from "./quality-recorder.js";
import { ServerAPI, Plugin } from "@signalk/server-api";
import { schema, uiSchema, Config } from "./config.js";
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

interface Session {
  controller: AbortController;
  reporting: AbortController;
  anonymous: boolean;
  reporter?: ReturnType<typeof createReporter>;
  stopping?: Promise<void>;
}

export default function createPlugin(app: ServerAPI): Plugin {
  let current: Session | undefined;

  return {
    id: "crowd-depth",
    name: "Crowd Depth",
    description:
      "Collect and share depth data with crowd-sourced bathymetry programs",

    start(config: Config) {
      app.debug("Starting (ENV=%s)", ENV);
      const status = createStatus(app);

      // Each start owns its lifetime, including an outstanding final upload.
      const controller = new AbortController();
      current?.controller.abort("Replaced crowd-depth instance");
      current?.reporting.abort("Replaced crowd-depth instance");
      const session: Session = {
        controller,
        reporting: new AbortController(),
        anonymous: config.sharing?.anonymous === true,
      };
      current = session;
      const db = createDB(join(app.getDataDirPath(), `bathymetry.sqlite`));
      try {
        pruneQuality(db);
      } catch (error) {
        app.error(`GPS quality cleanup unavailable: ${error}`);
      }
      // Resolve the sounder's path before any reader or chart captures its reference.
      void (async () => {
        const resolved = await resolveDepthConfig(
          app,
          config,
          controller.signal,
          db,
        );
        if (!resolved || controller.signal.aborted) return;
        const chart = startChartSafely({
          app,
          config: resolved,
          db,
          signal: controller.signal,
        });
        await settleAndReport({
          app,
          config: resolved,
          db,
          chart,
          status,
          session,
        });
      })().catch((err: unknown) => {
        if (!controller.signal.aborted) status.error(err as Error);
      });
    },

    stop(options) {
      const session = current;
      if (!session) return Promise.resolve();
      session.controller.abort("Stopping crowd-depth collection");
      try {
        const saved = app.readPluginOptions?.() as
          { enabled?: boolean; configuration?: Partial<Config> } | undefined;
        // Recheck even during a flush: another settings request can withdraw sharing.
        const morePrivate =
          saved?.configuration?.sharing?.anonymous && !session.anonymous;
        if (
          options?.reason === "disable" ||
          saved?.enabled === false ||
          morePrivate
        )
          session.reporting.abort("Sharing disabled or made anonymous");
      } catch (error) {
        session.reporting.abort("Could not read sharing settings");
        app.error(`Final report skipped: ${error}`);
      }
      if (session.stopping) return session.stopping;
      session.stopping = (async () => {
        try {
          if (!session.reporting.signal.aborted)
            await session.reporter?.flush();
        } catch (error) {
          if (!session.reporting.signal.aborted)
            app.error(
              `Final report failed; unreported data remains queued: ${error}`,
            );
        } finally {
          session.reporting.abort("Stopping crowd-depth reporter");
        }
      })();
      return session.stopping;
    },

    uiSchema() {
      return uiSchema(app);
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
  session: Session;
}

async function settleAndReport({
  app,
  config,
  db,
  chart,
  status,
  session,
}: SettleAndReportOptions) {
  const { controller } = session;
  const sqlite = createSqliteSource(app, db);
  const source = await settleSource({
    findHistory: () =>
      createHistorySource(app, config, {
        quality: (point, source) => recordedQuality(app, db, point, source),
      }),
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
  if (!source || controller.signal.aborted) return;

  if (source !== sqlite) {
    try {
      recordQuality(app, config, db, controller.signal);
    } catch (error) {
      app.error(`GPS quality capture unavailable: ${error}`);
    }
  }
  if (chart) {
    const chartSource =
      source === sqlite
        ? sqlite
        : await createHistorySource(app, config, { includeQuality: false });
    if (chartSource && !controller.signal.aborted)
      void chart.backfill(chartSource);
  }

  session.reporter = createReporter({
    app,
    config,
    source,
    db,
    status,
    signal: session.reporting.signal,
  });
}
