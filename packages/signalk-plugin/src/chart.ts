import { pipeline } from "stream/promises";
import { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { transform } from "stream-transform";
import { ServerAPI } from "@signalk/server-api";
import { Config, depthReference } from "./config.js";
import { BathymetrySource } from "./types.js";
import {
  correctForSensorPosition,
  createLiveStream,
  getOffsets,
} from "./streams/index.js";
import {
  CellStore,
  Layer,
  addPendingBackfill,
  backfillCells,
  clearPendingBackfill,
  createCellStore,
  createCellWriter,
  createTileService,
  recordBackfillFailure,
  registerLayerRoutes,
  DEPTH_SINCE_KEY,
  THROUGH_KEY,
} from "./tiles/index.js";
import { DEFINITIONS } from "./tiles/geometry.js";
import { registerPlotterExtension } from "./plotterext/provider.js";

/** Meta keys for the configuration the cells were built with. */
const POSITION_CONFIG_KEY = "config_position";
const DEPTH_CONFIG_KEY = "config_depth";

/** How the plugin turns soundings into cells. Bump it when that changes, so cells built
 * the old way are rebuilt. */
const LAYER_VERSION = 2;

/** The safety depth the layer draws with until the owner sets one, in metres. */
export const DEFAULT_SAFETY_DEPTH_M = 3;

/** What the routes and the plotter extension read; replaced on each start. */
let current: Layer | undefined;
let routesRegistered = false;

/** The settings the cells depend on: the depth path and offset, and the antenna to
 * transducer offset, QC and the cells' resolution, which place and judge each sounding.
 * The statistic's k and σs aren't among them: they're applied as tiles are drawn. */
export function cellConfig(config: Config) {
  const { distance, dx, dy } = getOffsets(config);
  return {
    position: JSON.stringify({
      transducer: distance > 0 ? { forward: dy, starboard: dx } : null,
      layer: LAYER_VERSION,
      qc: DEFINITIONS.qc,
      rows: DEFINITIONS.cells.rows_per_degree,
      columns: DEFINITIONS.cells.column_steps_divide,
    }),
    depth: JSON.stringify({
      depthPath: `environment.depth.${config.path}`,
      depthOffset: depthReference(config).offset,
    }),
  };
}

/**
 * Start the "My soundings" chart layer: fold the boat's live soundings into cells in the
 * plugin's database, serve them as vector tiles, and offer the layer to chartplotters
 * that support plotter extensions. Returns a backfill to run once the plugin's source is
 * known.
 */
export function startChart({
  app,
  config,
  db,
  signal,
}: {
  app: ServerAPI;
  config: Config;
  db: DatabaseSync;
  signal: AbortSignal;
}) {
  const store = createCellStore(db);
  const startedAt = Temporal.Now.instant();

  syncConfig(store, cellConfig(config), startedAt);
  // Before the live writer starts, so its marker doesn't hide the gap.
  addPendingBackfill(store, startedAt);

  const tiles = createTileService(store, db.location() ?? undefined);
  const writer = createCellWriter(store, { onChange: tiles.changed });
  // Until the backfill has run, so its older passes go into the cells first.
  writer.hold(true);
  const started: Layer = {
    tiles,
    provisional: writer.provisional,
    safetyDepth: config.chart?.safetyDepth ?? DEFAULT_SAFETY_DEPTH_M,
  };
  current = started;
  // Only this start's own state: an older start can end after a newer one
  // replaced it.
  const stop = () => {
    tiles.close();
    if (current === started) current = undefined;
  };
  signal.addEventListener("abort", stop);

  pipeline(
    createLiveStream(app, config),
    transform(correctForSensorPosition(config)),
    writer,
    { signal },
  ).catch((err: unknown) => {
    if (signal.aborted) return;
    app.error(`Chart layer stopped: ${err}`);
    // Stop offering a layer that no longer updates.
    stop();
  });

  registerPlotterExtension(app, () => current !== undefined);
  if (!routesRegistered) {
    registerLayerRoutes(app, () => current);
    routesRegistered = true;
  }

  return {
    backfill: (source: BathymetrySource) => {
      return backfillCells({ app, config, source, store, signal })
        .then(() => {
          writer.hold(false);
          tiles.reset();
        })
        .catch((err: unknown) => {
          if (signal.aborted) return;
          writer.hold(false);
          tiles.reset();
          // The span stays for the next start, a few times at most; the live
          // layer goes on either way.
          const retry = recordBackfillFailure(store);
          app.error(
            `Chart backfill failed${retry ? ", will retry on restart" : ""}: ${err}`,
          );
        });
    },
  };
}

/**
 * Cells hold soundings corrected with the offsets of their day, judged and placed by the
 * grid's definitions of their build. When any of those change, the old cells would sit
 * beside the new, so they're cleared for a rebuild. Run on every start, including while
 * the layer is off, so a depth reference change is dated when it happens.
 */
function syncConfig(
  store: CellStore,
  { position, depth }: ReturnType<typeof cellConfig>,
  startedAt: Temporal.Instant,
) {
  // A first start has nothing recorded under another depth reference.
  const previousDepth = store.getMeta(DEPTH_CONFIG_KEY);
  const depthChanged = previousDepth !== undefined && previousDepth !== depth;
  if (store.getMeta(POSITION_CONFIG_KEY) !== position || depthChanged) {
    store.clear();
    store.setMeta(THROUGH_KEY, "");
    clearPendingBackfill(store);
    if (depthChanged) store.setMeta(DEPTH_SINCE_KEY, startedAt.toString());
    store.setMeta(POSITION_CONFIG_KEY, position);
  }
  store.setMeta(DEPTH_CONFIG_KEY, depth);
}

/**
 * Start the chart layer unless it is turned off, without letting it stop the
 * plugin: a failure here (a locked database, a refused provider) is logged and
 * the plugin goes on collecting and sharing without the layer.
 */
export function startChartSafely(options: Parameters<typeof startChart>[0]) {
  try {
    if (options.config.chart?.show === false) {
      syncConfig(
        createCellStore(options.db),
        cellConfig(options.config),
        Temporal.Now.instant(),
      );
      return undefined;
    }
    return startChart(options);
  } catch (err) {
    options.app.error(`Chart layer failed to start: ${err}`);
    return undefined;
  }
}
