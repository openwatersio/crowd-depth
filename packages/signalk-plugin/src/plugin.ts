import { setTimeout as sleep } from "node:timers/promises";
import { createSourceDiscovery } from "./source-discovery.js";
import { gnssOffsets } from "./gnss-offsets.js";
import { ServerAPI, Plugin } from "@signalk/server-api";
import {
  schema,
  uiSchema,
  selectDepth,
  resolveSource,
  Config,
} from "./config.js";
import { createReporter } from "./reporters/index.js";
import { createSqliteSource } from "./sources/sqlite.js";
import { BATHY_HISTORY_WAIT, ENV } from "./constants.js";
import { createHistorySource } from "./sources/history.js";
import { settleSource } from "./sources/settle.js";
import { createDB } from "./storage.js";
import { join } from "path";
import { createCollector } from "./collector.js";
import { createStatus, Status } from "./status.js";
import { collectObservations } from "./observations/collect.js";
import { startChartSafely } from "./chart.js";

interface Session {
  controller: AbortController;
  reporting: AbortController;
  anonymous: boolean;
  reporter?: ReturnType<typeof createReporter>;
  observations?: Promise<void>;
  chartReady?: Promise<ReturnType<typeof startChartSafely>>;
  previousClosed: Promise<void>;
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
      const previous = current;
      current?.controller.abort("Replaced crowd-depth instance");
      current?.reporting.abort("Replaced crowd-depth instance");
      const session: Session = {
        controller,
        reporting: new AbortController(),
        anonymous: config.sharing?.anonymous === true,
        previousClosed: Promise.allSettled([
          previous?.previousClosed,
          previous?.chartReady?.then((chart) => chart?.close()),
        ]).then(() => undefined),
      };
      current = session;
      const ready = (config: Config) => {
        const db = createDB(join(app.getDataDirPath(), `bathymetry.sqlite`));
        const createChart = () => {
          if (controller.signal.aborted) return undefined;
          const chart = startChartSafely({
            app,
            config,
            db,
            signal: controller.signal,
          });
          return chart;
        };
        const chart = previous
          ? session.previousClosed.then(createChart)
          : Promise.resolve(createChart());
        session.chartReady = chart;
        session.observations = (
          previous?.observations ?? Promise.resolve()
        ).then(async () => {
          let delay = 5000;
          while (!controller.signal.aborted) {
            try {
              await collectObservations(
                app,
                config,
                join(app.getDataDirPath(), "observations.sqlite"),
                controller.signal,
                () => {
                  delay = 5000;
                  if (!controller.signal.aborted)
                    status.clearError("observations");
                },
              );
              if (!controller.signal.aborted) status.clearError("observations");
              return;
            } catch (error) {
              if (controller.signal.aborted) {
                app.error(`Observation drain failed during stop: ${error}`);
                return;
              }
              status.error(
                new Error(
                  `Original observation recording interrupted: ${error}`,
                ),
                "observations",
              );
              if (controller.signal.aborted) return;
              try {
                await sleep(delay, undefined, { signal: controller.signal });
              } catch {
                return;
              }
              delay = Math.min(delay * 2, 300000);
            }
          }
        });

        // Settling can wait up to BATHY_HISTORY_WAIT for a history provider, so
        // it runs in the background and start() doesn't hold up the server.
        void settleAndReport({
          app,
          config,
          db,
          chart,
          status,
          session,
        }).catch((err: unknown) => {
          if (!controller.signal.aborted) status.error(err as Error);
        });
      };
      // Older progressive previews saved neither a path nor horizontal offsets.
      // Keep that configuration usable; normal upstream settings start immediately.
      if (
        config.path &&
        Number.isFinite(config.gnss.x) &&
        Number.isFinite(config.gnss.y) &&
        !resolveSource(
          app,
          config.gnss.source,
          "navigation.position",
        )?.endsWith(".ccrp")
      ) {
        ready(config);
      } else {
        void resolveLegacyConfig(app, config, controller.signal, status)
          .then((resolved) => {
            if (!controller.signal.aborted) ready(resolved);
          })
          .catch((error: unknown) => {
            if (!controller.signal.aborted) status.error(error);
          });
      }
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
          await Promise.all([
            session.observations,
            session.previousClosed,
            session.chartReady?.then((chart) => chart?.close()),
          ]);
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
  chart: Promise<ReturnType<typeof startChartSafely>>;
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
  if (!source || controller.signal.aborted) return;

  void chart
    .then((ready) => {
      if (!controller.signal.aborted) return ready?.backfill(source);
    })
    .catch((error: unknown) => {
      if (!controller.signal.aborted)
        app.error(`Chart backfill stopped: ${error}`);
    });

  session.reporter = createReporter({
    app,
    config,
    source,
    db,
    status,
    signal: session.reporting.signal,
  });
}

async function resolveLegacyConfig(
  app: ServerAPI,
  config: Config,
  signal: AbortSignal,
  status: Status,
): Promise<Config> {
  const discover = createSourceDiscovery(app);
  let resolved = config;
  if (!resolved.path) status.set({ waitingForDepth: true });
  while (!resolved.path) {
    signal.throwIfAborted();
    const depth =
      selectDepth(app, config.sounder.source) ??
      selectDepth(app, config.sounder.source, await discover());
    if (depth) {
      resolved = {
        ...config,
        path: depth.path,
      };
    } else await sleep(2000, undefined, { signal });
  }
  status.set({ waitingForDepth: false });
  if (
    !Number.isFinite(resolved.gnss.x) ||
    !Number.isFinite(resolved.gnss.y) ||
    resolveSource(app, resolved.gnss.source, "navigation.position")?.endsWith(
      ".ccrp",
    )
  ) {
    let source = resolveSource(
      app,
      resolved.gnss.source,
      "navigation.position",
    );
    if (!source) {
      status.error(
        new Error(
          "Waiting for the selected GPS source to resolve its antenna geometry",
        ),
        "configuration",
      );
      while (!source) {
        await sleep(2000, undefined, { signal });
        source = resolveSource(
          app,
          resolved.gnss.source,
          "navigation.position",
        );
      }
    }
    status.clearError("configuration");
    const geometry = gnssOffsets(app, source, resolved.gnss);
    resolved = {
      ...resolved,
      // Inferred geometry belongs to this receiver, including its correction mode.
      gnss: { ...resolved.gnss, ...geometry.gnss, source },
      positionOrigin: geometry.positionOrigin,
    };
  }
  return resolved;
}
