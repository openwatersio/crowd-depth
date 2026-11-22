import type { DatabaseSync } from "node:sqlite";
import type { Path, ServerAPI, SourceRef } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Config,
  DepthPaths,
  selectDepthPath,
  resolvedDepthPaths,
} from "./config.js";
import { sameSource } from "./device-info.js";
import { BATHY_EPOCH } from "./constants.js";
import { getHistoryAPI } from "./sources/history.js";

/** One path per session keeps depth conversion and report reference consistent. */
export async function resolveDepthConfig(
  app: ServerAPI,
  config: Config,
  signal: AbortSignal,
  db?: DatabaseSync,
): Promise<Config | undefined> {
  const discovery = new AbortController();
  const lookupSignal = AbortSignal.any([signal, discovery.signal]);
  const selection = config.sounder.source || "";
  const row = db
    ?.prepare("SELECT value FROM tile_meta WHERE key = 'resolved_depth'")
    .get() as { value: string } | undefined;
  let remembered:
    | { source: string; path: Config["path"]; legacyPath?: Config["path"] }
    | undefined;
  try {
    remembered = row ? JSON.parse(row.value) : undefined;
  } catch {
    /* Recover from an invalid optional cache. */
  }
  const remember = (path: Config["path"]) => {
    if (signal.aborted) return;
    discovery.abort();
    resolvedDepthPaths.set(app, { source: selection, path });
    db?.prepare(
      "INSERT OR REPLACE INTO tile_meta(key, value) VALUES('resolved_depth', ?)",
    ).run(JSON.stringify({ source: selection, path, legacyPath: config.path }));
    return { ...config, path };
  };
  if (
    remembered &&
    config.path !== remembered.legacyPath &&
    DepthPaths.includes(config.path)
  )
    return remember(config.path);
  if (remembered?.source === selection && DepthPaths.includes(remembered.path))
    return remember(remembered.path);
  // Preserve existing data's reference on upgrade; later source changes redetect.
  if (!remembered && DepthPaths.includes(config.path))
    return remember(config.path);
  const live = selectDepthPath(app, config.sounder.source);
  if (live) {
    await sleep(1000, undefined, { signal }).catch(() => {});
    return remember(selectDepthPath(app, config.sounder.source) ?? live);
  }
  let recorded: Config["path"] | undefined;
  let pending = false;
  let retryAt = 0;
  let retryDelay = 60_000;
  app.setPluginStatus("Waiting for depth data to select the sounder's path");
  while (!signal.aborted) {
    const path = selectDepthPath(app, config.sounder.source) ?? recorded;
    if (path) {
      await sleep(1000, undefined, { signal }).catch(() => {});
      return remember(selectDepthPath(app, config.sounder.source) ?? path);
    }
    if (!pending && Date.now() >= retryAt) {
      pending = true;
      void recordedPath(app, config, lookupSignal)
        .then((path) => {
          recorded = path;
        })
        .finally(() => {
          pending = false;
          retryAt = Date.now() + retryDelay;
          retryDelay = Math.min(retryDelay * 2, 6 * 3600_000);
        });
    }
    await sleep(1000, undefined, { signal }).catch(() => {});
  }
}

export async function recordedPath(
  app: ServerAPI,
  config: Config,
  signal: AbortSignal,
) {
  try {
    const history = await getHistoryAPI({ app });
    if (!history || signal.aborted) return;
    const source = config.sounder.source;
    if (source && history.supportsSourceSelection === false) return;
    const range = { from: BATHY_EPOCH, to: Temporal.Now.instant() };
    const paths = await history.getPaths(range);
    let latest: { path: Config["path"]; time: number } | undefined;
    for (const path of DepthPaths) {
      const full = `environment.depth.${path}` as Path;
      if (!paths.includes(full)) continue;
      // A coarse scan locates the newest occupied six-hour bucket, then a
      // one-second scan compares actual recent soundings across depth paths.
      try {
        const newest = async (
          from: Temporal.Instant,
          to: Temporal.Instant,
          resolution: number,
        ) => {
          signal.throwIfAborted();
          const response = await history.getValues({
            from,
            to,
            resolution,
            pathSpecs: [
              {
                path: full,
                ...(source ? { sourceRef: source as SourceRef } : {}),
                aggregate: "max",
                parameter: [],
              },
            ],
          });
          signal.throwIfAborted();
          const index = !response.values?.length
            ? source
              ? -1
              : 0
            : response.values.findIndex(
                (column) =>
                  column.path === full &&
                  (!source || sameSource(app, column.$source, source)),
              );
          if (index === undefined || index < 0) return;
          let time: number | undefined;
          for (const row of response.data) {
            const value = row[index + 1];
            const stamp = Date.parse(row[0]);
            if (
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value <= 0 ||
              !Number.isFinite(stamp) ||
              stamp < from.epochMilliseconds ||
              stamp >= to.epochMilliseconds
            )
              continue;
            if (time === undefined || stamp > time) time = stamp;
          }
          return time;
        };
        const bucket = await newest(range.from, range.to, 21600);
        if (bucket === undefined) continue;
        const end = Math.min(bucket + 21600_000, range.to.epochMilliseconds);
        const time = await newest(
          Temporal.Instant.fromEpochMilliseconds(bucket),
          Temporal.Instant.fromEpochMilliseconds(end),
          1,
        );
        if (time !== undefined && (!latest || time > latest.time))
          latest = { path, time };
      } catch (error) {
        app.debug("Depth history path %s unavailable: %s", full, error);
      }
    }
    return signal.aborted ? undefined : latest?.path;
  } catch (error) {
    app.debug("Depth path discovery unavailable: %s", error);
  }
}
