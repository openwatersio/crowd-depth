import { Config, resolveSource } from "../config.js";
import { Readable } from "stream";
import { BathymetryData, BathymetrySource, Timeframe } from "../types.js";
import { Path, ServerAPI, SourceRef } from "@signalk/server-api";
import {
  ContextsRequest,
  ContextsResponse,
  HistoryApi,
  PathsRequest,
  PathsResponse,
  ValuesRequest,
  ValuesResponse,
} from "@signalk/server-api/history";
import { Temporal } from "@js-temporal/polyfill";
import { BATHY_EPOCH } from "../constants.js";
import fetch from "../fetch.js";

export async function createHistorySource(
  app: ServerAPI,
  config: Config,
  options: HistorySourceOptions = {},
): Promise<BathymetrySource | undefined> {
  const history = await getHistoryAPI({ app, ...options });

  if (!history) return;

  async function createReader({ from, to }: Timeframe) {
    app.debug("Reading history from %s to %s", from, to);

    // Pin position and depth each to a single source (the configured one, else
    // the source Signal K prioritizes). A vessel can carry more than one GPS,
    // and their antenna offsets differ, so mixing sources would smear the
    // soundings' locations.
    const depthPath = `environment.depth.${config.path}`;
    const positionSource = resolveSource(
      app,
      config.gnss?.source,
      "navigation.position",
    );
    const depthSource = resolveSource(app, config.sounder?.source, depthPath);

    const req: ValuesRequest = {
      from,
      to,
      // 1s buckets: position updates ~1/s, so each bucket pairs a depth sounding
      // with a position fix. Finer loses fixes; coarser downsamples soundings.
      resolution: 1,
      pathSpecs: [
        {
          path: "navigation.position" as Path,
          aggregate: "first",
          parameter: [],
          ...(positionSource ? { sourceRef: positionSource as SourceRef } : {}),
        },
        {
          path: depthPath as Path,
          // signalk-to-influxdb returns null when requesting `first`, so using `min` instead
          aggregate: "min",
          parameter: [],
          ...(depthSource ? { sourceRef: depthSource as SourceRef } : {}),
        },
        {
          path: "navigation.headingTrue" as Path,
          aggregate: "average",
          parameter: [],
        },
      ],
    };

    let res: ValuesResponse;
    let pathSpecs = req.pathSpecs;
    try {
      res = await history!.getValues(req);
    } catch {
      // The provider throws if a requested path doesn't exist; retry without heading.
      // https://github.com/tkurki/signalk-to-influxdb2/issues/99
      pathSpecs = req.pathSpecs.slice(0, 2);
      res = await history!.getValues({ ...req, pathSpecs });
    }

    // Map columns by path rather than position: the provider may reorder them
    // or omit one entirely when a bucket has no data for it.
    const columns = columnsByPath(res.values, pathSpecs);
    const positionColumn = columns.get("navigation.position");
    const depthColumn = columns.get(depthPath);
    const headingColumn = columns.get("navigation.headingTrue");

    const data = res.data
      .map((row): BathymetryData | undefined => {
        const depth = depthColumn === undefined ? undefined : row[depthColumn];
        const heading =
          headingColumn === undefined ? undefined : row[headingColumn];
        const position =
          positionColumn === undefined
            ? undefined
            : (row[positionColumn] as [number, number] | null | undefined);
        const [longitude, latitude] = position ?? [];

        if (
          typeof depth === "number" &&
          Number.isFinite(depth) &&
          typeof longitude === "number" &&
          Number.isFinite(longitude) &&
          typeof latitude === "number" &&
          Number.isFinite(latitude)
        ) {
          return {
            timestamp: Temporal.Instant.from(row[0]),
            longitude,
            latitude,
            depth,
            heading: typeof heading === "number" ? heading : undefined,
          };
        }
      })
      .filter((point): point is BathymetryData => point !== undefined);

    app.debug("Read %d bathymetry points from history", data.length);

    if (data.length === 0) return;

    return Readable.from(data);
  }

  /**
   * Get the list of timeframes that there is data for in the history.
   */
  async function getAvailableTimeframes(
    timeframe: Timeframe,
    windowSize: Temporal.Duration,
  ) {
    const pathSpecs = [
      {
        path: ("environment.depth." + config.path) as Path,
        // signalk-to-influxdb returns null when requesting `first`, so using `min` instead
        aggregate: "min" as const,
        parameter: [],
      },
    ];
    // @ts-expect-error: https://github.com/SignalK/signalk-server/pull/2264
    const res = await history.getValues({
      from: timeframe.from,
      to: timeframe.to,
      resolution: windowSize.total("seconds"),
      pathSpecs,
    });

    const depthColumn = columnsByPath(res.values, pathSpecs).get(
      `environment.depth.${config.path}`,
    );
    if (depthColumn === undefined) return [];

    // Get days with depth data
    return res.data
      .filter((row) => Number.isFinite(row[depthColumn]))
      .map((row) => {
        const from = Temporal.Instant.from(row[0]);
        const to = from.add(windowSize);
        return new Timeframe(from, to);
      });
  }

  return {
    // History providers handle the recording of data themselves
    createWriter: undefined,
    createReader,
    getAvailableTimeframes,
  };
}

export interface HistorySourceOptions {
  port?: number;
  host?: string;
}

export type HistoryAPIOptions = {
  app: ServerAPI;
  host?: string;
};

// URLSearchParams thinks it needs strings, but will work with anything that can be converted to a string.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type URLSearchParamsOptions = Record<string, any>;

/**
 * The History Provider API is new and may not be available. This uses a provider if available,
 * and otherwise falls back to direct HTTP access if available.
 */
export async function getHistoryAPI({
  app,
  // @ts-expect-error: app.config is not a public API
  port = Number(process.env.PORT) || app.config?.settings?.port || 3000,
  host = process.env.SIGNALK_HOST ?? `http://localhost:${port}/`,
}: HistoryAPIOptions): Promise<HistoryApi | undefined> {
  try {
    // Try to get the built-in history provider API first. It either returns the API or throws
    // an error if no provider is configured. It will also throw if the API is not available.
    const api = await app.getHistoryApi!();
    app.debug("Using built-in history provider");
    return api;
  } catch {
    // History provider API not available or no provider configured.
  }

  try {
    await getContexts({
      from: BATHY_EPOCH,
      to: Temporal.Now.instant(),
    });
    app.debug("Using History API available at %s", host);
  } catch {
    app.debug("History API is not available");
    return;
  }

  return { getValues, getContexts, getPaths };

  async function get(path: string, params: URLSearchParamsOptions = {}) {
    const url = new URL(path, new URL("/signalk/v1/history/", host));
    url.search = new URLSearchParams(params).toString();

    app.debug("Fetching %s", url.toString());

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${res.status} ${res.statusText}`,
      );
    }

    return res.json();
  }

  function getValues({
    pathSpecs,
    ...query
  }: ValuesRequest): Promise<ValuesResponse> {
    return get("values", {
      ...query,
      paths: pathSpecs
        .map(({ path, aggregate }) => [path, aggregate].join(":"))
        .join(","),
    });
  }

  function getContexts(query?: ContextsRequest): Promise<ContextsResponse> {
    return get("contexts", query);
  }

  function getPaths(query?: PathsRequest): Promise<PathsResponse> {
    return get("paths", query);
  }
}

/**
 * Build a lookup from SignalK path to its column index in a history `DataRow`.
 *
 * `values[i]` describes data column `i + 1` (column 0 is always the timestamp),
 * so the returned index can be used directly against a `DataRow`. The response's
 * `values` metadata is authoritative — v2+ providers may reorder or drop columns
 * — but providers that omit it fall back to the requested path order. When a
 * path appears more than once the first matching column wins.
 */
function columnsByPath(
  values: ValuesResponse["values"] | undefined,
  requested: readonly { path: Path }[],
): Map<string, number> {
  const source = values && values.length ? values : requested;
  const columns = new Map<string, number>();
  source.forEach((column, i) => {
    if (!columns.has(column.path)) columns.set(column.path, i + 1);
  });
  return columns;
}
