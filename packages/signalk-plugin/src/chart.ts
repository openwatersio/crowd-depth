import { pipeline } from "stream/promises";
import { setTimeout } from "node:timers/promises";
import { BATHY_REPORT_DELAY } from "./constants.js";
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
  tideChanged,
  TIDES_WAIT_MS,
  clearPendingBackfill,
  getPendingBackfill,
  createCellStore,
  createCellWriter,
  createTileService,
  recordBackfillFailure,
  registerLayerRoutes,
  DEPTH_SINCE_KEY,
  THROUGH_KEY,
} from "./tiles/index.js";
import { DEFINITIONS } from "./tiles/geometry.js";
import {
  ApiError,
  createTides,
  httpJson,
  tidesInstalled,
  tidesUrl,
  withTide,
} from "./tiles/tide.js";
import { createQCThread } from "./tiles/qc-thread.js";
import { registerPlotterExtension } from "./plotterext/provider.js";

/** Meta keys for the configuration the cells were built with. */
const POSITION_CONFIG_KEY = "config_position";
const DEPTH_CONFIG_KEY = "config_depth";

/** How the plugin turns soundings into cells. Bump it when that changes, so cells built
 * the old way are rebuilt. */
const LAYER_VERSION = 5;

/** A backfill span longer than this holds live passes back until it's done. */
const HOLD_FOR_HOURS = 1;

/** The safety depth the layer draws with until the owner sets one, in metres. */
export const DEFAULT_SAFETY_DEPTH_M = 3;

/** What the routes and the plotter extension read; replaced on each start. */
let current: Layer | undefined;
let routesRegistered = false;

/** The settings the cells depend on: the depth path and offset, and the antenna to
 * transducer offset, QC and the cells' resolution, which place and judge each sounding.
 * The statistic's k and σs aren't among them: they're applied as tiles are drawn, and
 * the tide is the backfill's to check (`TIDE_CONFIG_KEY`), once signalk-tides answers. */
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

  // First, so a refused provider stops the start before anything runs.
  registerPlotterExtension(app, () => current !== undefined);
  if (!routesRegistered) {
    registerLayerRoutes(app, () => current);
    routesRegistered = true;
  }

  syncConfig(store, cellConfig(config), startedAt);
  // Before the live writer starts, so its marker doesn't hide the gap.
  addPendingBackfill(store, startedAt);

  const tiles = createTileService(store, db.location() ?? undefined);
  // Off the main thread, given a database file to say the plugin is built and running.
  const qc = db.location() ? createQCThread() : undefined;
  const writer = createCellWriter(store, {
    onChange: tiles.changed,
    qc: qc?.run,
    onError: (err) => app.error(`Chart layer: ${err.message}`),
  });
  // One for the live writer and the backfill, so they share what they've fetched. Without
  // signalk-tides the soundings stay untided, and the tiles say so.
  const tides = tidesInstalled(app)
    ? createTides(httpJson(tidesUrl(app)))
    : undefined;
  // Asked once at start; signalk-tides may start after this plugin.
  const tided = (tides?.ready(TIDES_WAIT_MS, { signal }) ?? Promise.reject())
    .then(() => true)
    .catch((err: unknown) => {
      if (!tides) {
        app.debug("signalk-tides isn't installed: the chart layer is untided");
      } else if (
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        // For the owner to fix.
        app.error(
          "Chart layer can't read signalk-tides without read-only access, so it's untided",
        );
      } else {
        app.debug(
          `signalk-tides isn't answering, so the chart layer is untided: ${err}`,
        );
      }
      return false;
    });
  // Until the backfill has run, so its older passes go into the cells first; only for
  // a span long enough for the order to matter, so a restart's short gap doesn't
  // freeze the layer while the source is found.
  const gap = getPendingBackfill(store);
  const long =
    gap !== undefined && gap.to.since(gap.from).total("hours") > HOLD_FOR_HOURS;
  // A tide change rebuilds every cell from the backfill, so live passes wait for the
  // start's tide check, a moment where signalk-tides answers, and through the rebuild
  // if it finds one; nothing written meanwhile is cleared with the cells.
  if (long || tides || tideChanged(store, false)) writer.hold(true);
  void tided.then((answered) => {
    if (!long && !tideChanged(store, answered) && !signal.aborted) {
      writer.hold(false);
    }
  });
  const started: Layer = {
    tiles,
    provisional: writer.provisional,
    stored: writer.stored,
    safetyDepth: config.chart?.safetyDepth ?? DEFAULT_SAFETY_DEPTH_M,
  };
  current = started;
  // Only this start's own state: an older start can end after a newer one
  // replaced it.
  const stop = () => {
    tiles.close();
    qc?.close();
    if (current === started) current = undefined;
  };
  signal.addEventListener("abort", stop);

  pipeline(
    createLiveStream(app, config),
    transform(correctForSensorPosition(config)),
    ...(tides ? [withTide(tides)] : []),
    writer,
    { signal },
  ).catch((err: unknown) => {
    if (signal.aborted) return;
    app.error(`Chart layer stopped: ${err}`);
    // Stop offering a layer that no longer updates.
    stop();
  });

  return {
    backfill: async (source: BathymetrySource) => {
      // A History provider such as signalk-to-influxdb2 writes a minute or more late,
      // so the soundings just before this start aren't there to read yet. Wait as the
      // reporter does; the plugin's own log is written as soundings arrive.
      if (!source.createWriter) {
        const wait =
          startedAt.add(BATHY_REPORT_DELAY).epochMilliseconds - Date.now();
        if (wait > 0)
          await setTimeout(wait, undefined, { signal }).catch(() => {});
        if (signal.aborted) return;
      }
      return backfillCells({
        app,
        config,
        source,
        store,
        signal,
        file: db.location() ?? undefined,
        tides,
        until: startedAt,
      })
        .then(() => {
          // Stopped meanwhile: the writer is gone, and its held passes with it.
          if (signal.aborted) return;
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
