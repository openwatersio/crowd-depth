import { halfLifeDays } from "./tiles/decay.js";
import { refineHistory, refineVisible, reweightCells } from "./tiles/refine.js";
import { TIDE_CONFIG_KEY, tideConfig } from "./tiles/backfill.js";
import { cacheChartInputs } from "./tiles/inputs.js";
import type { PreviewView } from "./tiles/history-preview.js";
import { randomUUID } from "node:crypto";
import { pipeline } from "stream/promises";
import {
  createPreviewStore,
  scanPreview,
  observation,
} from "./tiles/history-preview.js";
import { createSqliteSource } from "./sources/sqlite.js";
import type { BathymetryData } from "./types.js";
import { setTimeout } from "node:timers/promises";
import { BATHY_REPORT_DELAY } from "./constants.js";
import { DatabaseSync } from "node:sqlite";
import type { Detail } from "./tiles/surface.js";
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
  tideChanged,
  TIDES_WAIT_MS,
  createCellStore,
  createCellWriter,
  createTileService,
  createKeptTiles,
  startRebuild,
  recordBackfillFailure,
  registerLayerRoutes,
  DEPTH_SINCE_KEY,
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
import { createPreview } from "./tiles/preview.js";
import { createQCThread } from "./tiles/qc-thread.js";
import { registerPlotterExtension } from "./plotterext/provider.js";
import { DEFAULT_OWN_STYLE, TINTS, type OwnStyle } from "./tiles/style.js";

/** Meta keys for the configuration the cells were built with. */
const POSITION_CONFIG_KEY = "config_position";
const DEPTH_CONFIG_KEY = "config_depth";

/** How the plugin turns soundings into cells. Bump it when that changes, so cells built
 * the old way are rebuilt. */
const LAYER_VERSION = 6;

/** The safety depth the layer draws with until the owner sets one, in metres. */
export const DEFAULT_SAFETY_DEPTH_M = 3;

const HEX = /^#[0-9a-f]{6}$/i;

/** The boat's own colours, tint and contours from the settings, a hand-edited value
 * that isn't one falling back to the default. */
export function ownStyle(config: Config): OwnStyle {
  const { color, shoalColor, tint, contours } = config.chart ?? {};
  const d = DEFAULT_OWN_STYLE;
  return {
    accent: color && HEX.test(color) ? color : d.accent,
    shoal: shoalColor && HEX.test(shoalColor) ? shoalColor : d.shoal,
    tint: tint && Object.hasOwn(TINTS, tint) ? tint : d.tint,
    contours: typeof contours === "boolean" ? contours : d.contours,
  };
}

/** What the routes and the plotter extension read; replaced on each start. */
let current: Layer | undefined;
let routesRegistered = false;

/** The settings the cells depend on: the depth path and offset, and the antenna to
 * transducer offset, QC and the cells' resolution, which place and judge each sounding,
 * and the selected sensors.
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
      sounderSource: config.sounder.source,
      gnssSource: config.gnss.source,
    }),
    weight: String(halfLifeDays(config.chart?.halfLifeDays)),
    depth: JSON.stringify({
      sourceSelection: 1,
      sounderSource: config.sounder.source || "",
      positionSource: config.gnss.source || "",
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
  const generation = randomUUID();
  const store = createCellStore(db, generation);
  const startedAt = Temporal.Now.instant();

  // First, so a refused provider stops the start before anything runs.
  registerPlotterExtension(app, () => current !== undefined);
  if (!routesRegistered) {
    registerLayerRoutes(app, () => current);
    routesRegistered = true;
  }

  store.setMeta("build_generation", generation);
  syncConfig(store, cellConfig(config), startedAt);
  // Before the live writer starts, so its marker doesn't hide the gap.
  addPendingBackfill(store, startedAt);
  const preview = createPreviewStore(
    db,
    JSON.stringify({
      version: 1,
      position: getOffsets(config),
      path: config.path,
      offset: depthReference(config).offset,
      sounder: config.sounder.source,
      gnss: config.gnss.source,
    }),
  );
  let previewRun: AbortController | undefined;
  let previewView: PreviewView | undefined;
  const boatView = (): PreviewView | undefined => {
    const p = app.getSelfPath("navigation.position.value") as
      { longitude?: number; latitude?: number } | undefined;
    if (!Number.isFinite(p?.longitude) || !Number.isFinite(p?.latitude)) return;
    const lon = p!.longitude!,
      lat = p!.latitude!;
    return [
      14,
      Math.max(-180, lon - 0.05),
      Math.max(-85.05, lat - 0.05),
      Math.min(180, lon + 0.05),
      Math.min(85.05, lat + 0.05),
    ];
  };
  const startPreview = (source: BathymetrySource) => {
    previewRun?.abort();
    previewRun = new AbortController();
    const since = source.createWriter
      ? store.getMeta(DEPTH_SINCE_KEY)
      : undefined;
    void scanPreview({
      source,
      store: preview,
      config,
      signal: previewRun.signal,
      until: startedAt.epochMilliseconds,
      view: () => previewView ?? boatView(),
      ...(since
        ? { since: Temporal.Instant.from(since).epochMilliseconds }
        : {}),
      onError: (err) => app.debug(`Chart preview source error: ${err}`),
    }).catch((err) => {
      if (!signal.aborted) app.debug(`Chart preview stopped: ${err}`);
    });
  };
  const waitingForTide = new Map<number, BathymetryData>();
  const changed = new Map<string, { lon: number; lat: number }>();
  const publishChanges = () => {
    if (!changed.size || signal.aborted) return;
    tiles.changed([...changed.values()]);
    changed.clear();
  };

  const detail =
    config.chart?.contourDetail === "standard" ? "standard" : "high";
  const file = db.location() ?? undefined;
  // Build requested tiles only: eager all-history warming saturated the Pi for 36 minutes.
  const tiles = createTileService(
    store,
    file,
    detail,
    file ? keepTiles(db, detail, app) : undefined,
  );
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
  // The contribution ledger replays each cell in time order, so historical
  // acquisition no longer holds live passes. Only a possible tide rebuild does.
  if (tides || tideChanged(store, false)) writer.hold(true);
  void tided.then((answered) => {
    if (!signal.aborted && !tideChanged(store, answered)) writer.hold(false);
  });
  const started: Layer = {
    tiles,
    provisional: () => [
      ...writer.provisional(),
      ...[...waitingForTide.values()].flatMap((data) => {
        const s = observation(data);
        return s ? [{ ...s, time: s.time * 1000 }] : [];
      }),
    ],
    historyPreview: (view) => {
      previewView = view;
      return preview.features(view ?? boatView(), 0);
    },
    stored: writer.stored,
    safetyDepth: config.chart?.safetyDepth ?? DEFAULT_SAFETY_DEPTH_M,
    own: ownStyle(config),
    detail,
    preview: createPreview(writer, tiles.preview),
  };
  const publish = setInterval(publishChanges, 5000);
  publish.unref?.();
  current = started;
  // Only this start's own state: an older start can end after a newer one
  // replaced it.
  const stop = () => {
    clearInterval(publish);
    previewRun?.abort();
    preview.close();
    waitingForTide.clear();
    tiles.close();
    qc?.close();
    if (current === started) current = undefined;
  };
  signal.addEventListener("abort", stop);

  pipeline(
    createLiveStream(app, config),
    transform(correctForSensorPosition(config)),
    transform((data: BathymetryData) => {
      if (observation(data))
        waitingForTide.set(data.timestamp.epochMilliseconds, data);
      while (waitingForTide.size > 1000)
        waitingForTide.delete(waitingForTide.keys().next().value!);
      return data;
    }),
    ...(tides ? [withTide(tides)] : []),
    transform((data: BathymetryData) => {
      waitingForTide.delete(data.timestamp.epochMilliseconds);
      return data;
    }),
    writer,
    { signal },
  ).catch((err: unknown) => {
    if (signal.aborted) return;
    app.error(`Chart layer stopped: ${err}`);
    // Stop offering a layer that no longer updates.
    stop();
  });

  const reweighted = reweightCells({
    store,
    signal,
    file,
    onChange: tiles.changed,
  }).catch((err) => {
    if (!signal.aborted) app.error(`Chart reweight remains pending: ${err}`);
  });

  // Existing local history is useful even while plugin startup waits for a provider.
  startPreview(createSqliteSource(app, db));
  return {
    backfill: async (source: BathymetrySource) => {
      await reweighted;
      if (signal.aborted) return;
      if (!source.createWriter) {
        source = cacheChartInputs(
          db,
          source,
          JSON.stringify({
            version: 1,
            path: config.path,
            offset: depthReference(config).offset,
            sounder: config.sounder.source,
            gnss: config.gnss.source,
          }),
          signal,
        );
      }
      startPreview(source);
      // Worker commits publish periodically; do not retain shared surfaces between them.
      tiles.share(false);
      const run = async (availableThrough?: Temporal.Instant) => {
        let retryMs = 30_000;
        while (!signal.aborted) {
          try {
            await refineHistory({
              config,
              source,
              store,
              signal,
              file: db.location() ?? undefined,
              tides: useTides ? tides : undefined,
              availableThrough,
              view: () => previewView ?? boatView(),
              onError: (err) =>
                app.error(`Chart refinement window remains pending: ${err}`),
              onChange: (positions) => {
                for (const point of positions)
                  changed.set(`${point.lon}/${point.lat}`, point);
                publishChanges();
              },
            });
            return;
          } catch (err) {
            if (signal.aborted) return;
            app.error(`Chart refinement will retry: ${err}`);
            await setTimeout(retryMs, undefined, { signal }).catch(() => {});
            retryMs = Math.min(retryMs * 2, 15 * 60_000);
          }
        }
      };
      const useTides = await tided;
      if (signal.aborted) return;
      if (tideChanged(store, useTides)) {
        startRebuild(store);
        addPendingBackfill(store, startedAt);
      }
      store.setMeta(TIDE_CONFIG_KEY, tideConfig(useTides));
      writer.hold(false);
      void refineVisible({
        source,
        store,
        config,
        signal,
        file,
        tides: useTides ? tides : undefined,
        availableThrough: source.createWriter
          ? startedAt
          : startedAt.subtract(BATHY_REPORT_DELAY),
        timestamps: () =>
          preview
            .features(previewView ?? boatView(), 0)
            .map((f) => f.properties.time),
        onChange: tiles.changed,
        onError: (err) =>
          app.error(`Visible chart refinement will retry: ${err}`),
      }).catch((err) => {
        if (!signal.aborted)
          app.error(`Visible chart refinement stopped: ${err}`);
      });
      return (async () => {
        // Old history is already settled. Only the final provider tail needs
        // its buffering delay; it must not delay the entire historical build.
        await run(
          source.createWriter
            ? undefined
            : startedAt.subtract(BATHY_REPORT_DELAY),
        );
        if (!source.createWriter && !signal.aborted) {
          const wait =
            startedAt.add(BATHY_REPORT_DELAY).epochMilliseconds - Date.now();
          if (wait > 0) await setTimeout(wait, undefined, { signal });
          if (!signal.aborted) await run();
        }
      })()
        .then(() => {
          // Stopped meanwhile: the writer is gone, and its held passes with it.
          if (signal.aborted) return;
          writer.hold(false);
          tiles.share(true);
          tiles.reset();
          changed.clear();
        })
        .catch((err: unknown) => {
          if (signal.aborted) return;
          writer.hold(false);
          tiles.share(true);
          tiles.reset();
          changed.clear();
          // Keep failed coverage pending for the next start; the live layer goes on.
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
  { position, depth, weight }: ReturnType<typeof cellConfig>,
  startedAt: Temporal.Instant,
) {
  // A first start has nothing recorded under another depth reference.
  const previousDepth = store.getMeta(DEPTH_CONFIG_KEY);
  const depthChanged = previousDepth !== undefined && previousDepth !== depth;
  if (store.getMeta(POSITION_CONFIG_KEY) !== position || depthChanged) {
    startRebuild(store);
    if (depthChanged) store.setMeta(DEPTH_SINCE_KEY, startedAt.toString());
    store.setMeta(POSITION_CONFIG_KEY, position);
  }
  if (store.getMeta("config_weight") !== weight) {
    store.transaction(() => {
      store.setMeta("config_weight", weight);
      store.setMeta("reweight_pending", "1");
      store.setMeta("reweight_after", "");
    });
  }
  store.setMeta(DEPTH_CONFIG_KEY, depth);
}

/** Tiles kept on disk, or none where they can't be: they only ever save building. */
function keepTiles(db: DatabaseSync, detail: Detail, app: ServerAPI) {
  try {
    return createKeptTiles(db, detail);
  } catch (err) {
    app.error(`Chart layer keeps no tiles on disk: ${err}`);
    return undefined;
  }
}

/**
 * Start the chart layer unless it is turned off, without letting it stop the
 * plugin: a failure here (a locked database, a refused provider) is logged and
 * the plugin goes on collecting and sharing without the layer.
 */
export function startChartSafely(options: Parameters<typeof startChart>[0]) {
  try {
    if (options.config.chart?.show === false) {
      createCellStore(options.db).setMeta("build_generation", randomUUID());
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
