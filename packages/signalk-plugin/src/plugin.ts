import { detectGpsdSensor } from "./gpsd-info.js";
import { gnssOffsets } from "./gnss-offsets.js";
import { setTimeout as sleep } from "node:timers/promises";
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
import { createStatus } from "./status.js";
import { startChartSafely } from "./chart.js";
import { createSourceDiscovery } from "./source-discovery.js";

export default function createPlugin(app: ServerAPI): Plugin {
  let abortController: AbortController | undefined = undefined;
  const discoverSources = createSourceDiscovery(app);

  return {
    id: "crowd-depth",
    name: "Crowd Depth",
    description:
      "Collect and share depth data with crowd-sourced bathymetry programs",

    async start(options: Omit<Config, "path"> & { path?: Config["path"] }) {
      app.debug("Starting (ENV=%s)", ENV);
      const status = createStatus(app);

      // A restart can replace abortController while this start still waits.
      const controller = new AbortController();
      abortController = controller;
      void initialize().catch((error: unknown) => {
        if (!controller.signal.aborted) status.error(error);
      });

      async function initialize() {
        status.set({ waitingForDepth: true });
        let selected;
        let gpsSource: string | undefined;
        while (!controller.signal.aborted) {
          // Live source identities do not need an all-history metadata query.
          selected = selectDepth(app, options.sounder.source, {}, options.path);
          gpsSource = resolveSource(
            app,
            options.gnss.source,
            "navigation.position",
          );
          if (selected && gpsSource) break;
          const recorded = await discoverSources();
          if (controller.signal.aborted) return;
          selected = selectDepth(
            app,
            options.sounder.source,
            recorded,
            options.path,
          );
          const positionSources = (
            recorded["navigation.position"] ?? []
          ).filter((source) => source !== "derived-data");
          gpsSource =
            resolveSource(app, options.gnss.source, "navigation.position") ??
            (positionSources.length === 1 ? positionSources[0] : undefined);
          if (selected && gpsSource) break;
          await sleep(2000, undefined, { signal: controller.signal });
        }
        if (!selected || !gpsSource || controller.signal.aborted) return;
        status.set({ waitingForDepth: false });
        const geometry = gnssOffsets(app, gpsSource, options.gnss);
        const config: Config = {
          ...options,
          path: selected.path,
          sounder: { ...options.sounder, source: selected.source },
          gnss: { ...options.gnss, ...geometry.gnss, source: gpsSource },
          positionOrigin: geometry.positionOrigin,
        };
        app.debug(
          "Selected depth source %s, path %s",
          selected.source,
          selected.path,
        );
        const db = createDB(join(app.getDataDirPath(), `bathymetry.sqlite`));
        const chart = startChartSafely({
          app,
          config,
          db,
          signal: controller.signal,
        });

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
    },

    stop() {
      abortController?.abort("Stopping crowd-depth plugin");
    },

    async uiSchema() {
      const recorded = await discoverSources();
      const result = uiSchema(app, recorded);
      const gpsSource = schema(app, recorded).properties.gnss.properties.source
        .default;
      const gpsd = await detectGpsdSensor(app, gpsSource);
      result.gnss.make["ui:placeholder"] ||= gpsd.make ?? "";
      return result;
    },

    async schema() {
      return schema(app, await discoverSources());
    },
  };
}
