import type { Path, ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";
import { DepthPaths, type RecordedSources } from "./config.js";
import { BATHY_EPOCH } from "./constants.js";

/** Discover before start(): a disabled plugin still needs a usable setup form. */
export function createSourceDiscovery(app: ServerAPI) {
  let cached: RecordedSources = {};
  let refreshed = 0;
  let failed = false;
  let pending: Promise<RecordedSources> | undefined;

  async function discover(): Promise<RecordedSources> {
    failed = false;
    if (!app.getHistoryApi) {
      failed = true;
      return {};
    }
    try {
      const history = await app.getHistoryApi();
      const to = Temporal.Now.instant();
      const range = { from: BATHY_EPOCH, to };
      const available = await history.getPaths(range);
      const paths = [
        "navigation.position",
        ...DepthPaths.map((path) => `environment.depth.${path}`),
      ].filter((path) => available.includes(path as Path));
      if (!paths.length) return {};
      const response = await history.getValues({
        ...range,
        // We only need column metadata, not a sample-by-sample history download.
        resolution: Math.max(
          1,
          Math.ceil(to.since(BATHY_EPOCH).total("seconds")),
        ),
        sourcePolicy: "all",
        pathSpecs: paths.map((path) => ({
          path: path as Path,
          aggregate: "min",
          parameter: [],
        })),
      });
      const result: RecordedSources = {};
      for (const column of response.values ?? []) {
        // Older providers may ignore sourcePolicy; never invent a source ref.
        if (!paths.includes(column.path) || !column.$source) continue;
        const sources = (result[column.path] ??= []);
        if (!sources.includes(column.$source)) sources.push(column.$source);
      }
      return result;
    } catch (error) {
      failed = true;
      app.debug("Could not discover history sources: %s", error);
      return {};
    }
  }

  return async (): Promise<RecordedSources> => {
    // Coalesce concurrent schema requests, including a provider still working
    // after the UI timeout. Failures retry after five seconds; successful source lists stay warm for an hour.
    const ttl = failed ? 5000 : Object.keys(cached).length ? 3600_000 : 60_000;
    if (Date.now() - refreshed < ttl) return cached;
    pending ??= discover()
      .then((result) => {
        cached = result;
        refreshed = Date.now();
        return result;
      })
      .finally(() => {
        pending = undefined;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<RecordedSources>((resolve) => {
          timer = setTimeout(() => resolve(cached), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
