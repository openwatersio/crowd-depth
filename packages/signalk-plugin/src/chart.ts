import { prepareKeptTiles } from "./tiles/kept.js";
import { isolateDamagedPreview } from "./tiles/preview-spatial.js";
import { halfLifeDays } from "./tiles/decay.js";
import {
  refineHistory,
  refineVisible,
  reweightCells,
  UncertainRefinementCommit,
} from "./tiles/refine.js";
import { TIDE_CONFIG_KEY, tideConfig } from "./tiles/backfill.js";
import { cacheChartInputs } from "./tiles/inputs.js";
import { createObservationStore } from "./observations/client.js";
import { storedHistorySource } from "./observations/source.js";
import { join } from "node:path";
import type { PreviewView } from "./tiles/history-preview.js";
import { randomUUID } from "node:crypto";
import { pipeline } from "stream/promises";
import {
  createPreviewStore,
  scanPreview,
  observation,
} from "./tiles/history-preview.js";
import { createSqliteSource } from "./sources/sqlite.js";
import { withoutBusyWait } from "./storage.js";
import type { BathymetryData } from "./types.js";
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
  tideChanged,
  TIDES_WAIT_MS,
  createCellStore,
  createCellWriter,
  createTileService,
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
  const lifetime = new AbortController();
  signal = AbortSignal.any([signal, lifetime.signal]);
  const generation = randomUUID();
  const store = createCellStore(db, generation);
  const startedAt = Temporal.Now.instant();
  const jobs = new Set<Promise<unknown>>();
  let observations: ReturnType<typeof createObservationStore> | undefined;
  const track = <T>(job: Promise<T>) => {
    jobs.add(job);
    void job.then(
      () => jobs.delete(job),
      () => jobs.delete(job),
    );
    return job;
  };

  // First, so a refused provider stops the start before anything runs.
  registerPlotterExtension(app, () => current !== undefined);
  if (!routesRegistered) {
    registerLayerRoutes(app, () => current);
    routesRegistered = true;
  }

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
    (busy) => writing(busy),
  );
  if (!preview.spatial)
    app.error(
      `Historical preview unavailable (${preview.unavailable}); collection and refined My Soundings remain enabled.`,
    );
  // Detach a damaged preview index before config changes can reset QC receipts.
  store.setMeta("build_generation", generation);
  syncConfig(store, cellConfig(config), startedAt);
  // Before the live writer starts, so its marker doesn't hide the gap.
  addPendingBackfill(store, startedAt);
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
    void track(
      scanPreview({
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
      }),
    ).catch((err) => {
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
  const tiles = createTileService(store, file, detail);
  if (file)
    void track(prepareKeptTiles(db, detail, signal))
      .then((kept) => {
        if (!signal.aborted) tiles.attachKept(kept);
      })
      .catch((error) => {
        if (!signal.aborted)
          app.error(`Chart layer keeps no tiles on disk: ${error}`);
      });
  let diskWriters = 0;
  const writing = (on: boolean) => {
    diskWriters += on ? 1 : -1;
    tiles.persist(diskWriters === 0);
  };
  void (async () => {
    let retryMs = 5000;
    while (!signal.aborted) {
      writing(true);
      try {
        await preview.prepare(previewView ?? boatView());
        return;
      } catch (err) {
        if (!signal.aborted)
          app.error(`Chart preview index incomplete; retrying: ${err}`);
      } finally {
        writing(false);
      }
      await setTimeout(retryMs, undefined, { signal }).catch(() => {});
      retryMs = Math.min(retryMs * 2, 300_000);
    }
  })();
  // Off the main thread, given a database file to say the plugin is built and running.
  const qc = db.location() ? createQCThread() : undefined;
  const writer = createCellWriter(
    {
      ...store,
      transaction: (fn) => withoutBusyWait(db, () => store.transaction(fn)),
    },
    {
      onChange: tiles.changed,
      qc: qc?.run,
      onError: (err) => app.error(`Chart layer: ${err.message}`),
    },
  );
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
  let stopping: Promise<void> | undefined;
  // Only this start's own state: an older start can end after a newer one
  // replaced it.
  const stop = () => {
    if (stopping) return stopping;
    signal.removeEventListener("abort", stop);
    lifetime.abort();
    clearInterval(publish);
    previewRun?.abort();
    waitingForTide.clear();
    qc?.close();
    if (current === started) current = undefined;
    stopping = Promise.allSettled([
      preview.close(),
      tiles.close(),
      ...jobs,
    ]).then(async () => {
      await observations?.close();
    });
    return stopping;
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

  writing(true);
  const reweighted = track(
    reweightCells({
      store,
      signal,
      file,
      onChange: tiles.changed,
    }),
  )
    .catch((err) => {
      if (!signal.aborted) {
        if (err instanceof UncertainRefinementCommit) tiles.reset();
        app.error(`Chart reweight remains pending: ${err}`);
      }
    })
    .finally(() => writing(false));

  // Existing local history is useful even while plugin startup waits for a provider.
  startPreview(createSqliteSource(app, db));
  return {
    close: stop,
    backfill: async (source: BathymetrySource) => {
      await reweighted;
      if (signal.aborted) return;
      if (!source.createWriter) {
        let retryMs = 5000;
        while (!signal.aborted) {
          try {
            if (source.createObservationReader) {
              observations ??= createObservationStore(
                join(app.getDataDirPath(), "observations.sqlite"),
              );
              await observations.ready;
              source = storedHistorySource(
                observations,
                source,
                config,
                signal,
              );
            } else
              source = await cacheChartInputs(
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
            break;
          } catch (error) {
            const failed = observations;
            observations = undefined;
            // Initialization failure has already been reported by ready; close also rejects it.
            await failed?.close().catch(() => {});
            if (signal.aborted) return;
            app.error(
              `Historical ${source.createObservationReader ? "observation storage" : "input cache"} unavailable; retrying in ${retryMs / 1000}s: ${error}`,
            );
            await setTimeout(retryMs, undefined, { signal }).catch(() => {});
            retryMs = Math.min(retryMs * 2, 300_000);
          }
        }
      }
      if (signal.aborted) return;
      startPreview(source);
      // Each refinement commit invalidates its surfaces; only disk-cache writes
      // need to stop while the worker can hold SQLite's write lock.
      const run = async (availableThrough?: Temporal.Instant) => {
        let retryMs = 30_000;
        while (!signal.aborted) {
          try {
            writing(true);
            try {
              await track(
                refineHistory({
                  config,
                  source,
                  store,
                  signal,
                  file: db.location() ?? undefined,
                  tides: useTides ? tides : undefined,
                  availableThrough,
                  view: () => previewView ?? boatView(),
                  onError: (err) => {
                    if (err instanceof UncertainRefinementCommit) tiles.reset();
                    app.error(
                      `Chart refinement window remains pending: ${err}`,
                    );
                  },
                  onChange: (positions) => {
                    for (const point of positions)
                      changed.set(`${point.lon}/${point.lat}`, point);
                    publishChanges();
                  },
                }),
              );
            } finally {
              writing(false);
            }
            return;
          } catch (err) {
            if (signal.aborted) return;
            if (err instanceof UncertainRefinementCommit) tiles.reset();
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
        tiles.reset();
        addPendingBackfill(store, startedAt);
      }
      store.setMeta(TIDE_CONFIG_KEY, tideConfig(useTides));
      writer.hold(false);
      void track(
        refineVisible({
          onBusy: writing,
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
          onError: (err) => {
            if (err instanceof UncertainRefinementCommit) tiles.reset();
            app.error(`Visible chart refinement will retry: ${err}`);
          },
        }),
      ).catch((err) => {
        if (!signal.aborted)
          app.error(`Visible chart refinement stopped: ${err}`);
      });
      return await (async () => {
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
          tiles.reset();
          changed.clear();
        })
        .catch((err: unknown) => {
          if (signal.aborted) return;
          writer.hold(false);
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
  const previousPosition = store.getMeta(POSITION_CONFIG_KEY);
  let compatible = previousDepth === depth;
  if (!compatible && previousDepth && previousPosition) {
    try {
      const old = JSON.parse(previousDepth);
      const sensors = JSON.parse(previousPosition);
      const next = JSON.parse(depth);
      // Older builds recorded the selected sensors in the position fingerprint.
      compatible =
        old.sourceSelection === undefined &&
        old.depthPath === next.depthPath &&
        old.depthOffset === next.depthOffset &&
        (sensors.sounderSource ?? "") === next.sounderSource &&
        (sensors.gnssSource ?? "") === next.positionSource;
    } catch {
      // Unproven provenance still requires a new recording boundary.
    }
  }
  const depthChanged = previousDepth !== undefined && !compatible;
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
  // Preserve an equivalent legacy fingerprint so rolling back does not mistake
  // a metadata-only upgrade for a new depth reference and discard chart history.
  store.setMeta(
    DEPTH_CONFIG_KEY,
    compatible && previousDepth ? previousDepth : depth,
  );
}

/**
 * Start the chart layer unless it is turned off, without letting it stop the
 * plugin: a failure here (a locked database, a refused provider) is logged and
 * the plugin goes on collecting and sharing without the layer.
 */
export function startChartSafely(options: Parameters<typeof startChart>[0]) {
  try {
    if (options.config.chart?.show === false) {
      const store = createCellStore(options.db);
      store.setMeta("build_generation", randomUUID());
      const sync = () =>
        syncConfig(store, cellConfig(options.config), Temporal.Now.instant());
      try {
        sync();
      } catch (error) {
        if (!isolateDamagedPreview(options.db, error)) throw error;
        sync();
      }
      return undefined;
    }
    return startChart(options);
  } catch (err) {
    options.app.error(`Chart layer failed to start: ${err}`);
    return undefined;
  }
}
