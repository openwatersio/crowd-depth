import { Config } from "../config.js";
import { Readable } from "stream";
import { BathymetryData, BathymetrySource, Timeframe } from "../types.js";
import { Path, ServerAPI } from "@signalk/server-api";
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

export async function createHistorySource(
  app: ServerAPI,
  config: Config,
  options: HistorySourceOptions = {},
): Promise<BathymetrySource | undefined> {
  const history = await getHistoryAPI({ app, ...options });

  if (!history) return;

  async function createReader({ from, to }: Timeframe) {
    app.debug("Reading history from %s to %s", from, to);
    const req: ValuesRequest = {
      from,
      to,
      resolution: 1, // 1 second,
      pathSpecs: [
        { path: "navigation.position" as Path, aggregate: "first" },
        {
          path: `environment.depth.${config.path}` as Path,
          // signalk-to-influxdb returns null when requesting `first`, so using `min` instead
          aggregate: "min",
        },
        {
          path: "navigation.headingTrue" as Path,
          aggregate: "average",
        },
      ],
    };

    let res: ValuesResponse;

    try {
      res = await history!.getValues(req);
    } catch {
      // API returns an error if you request a path that doesn't exist, so try again without heading
      // https://github.com/tkurki/signalk-to-influxdb2/issues/99
      res = res = await history!.getValues({
        ...req,
        pathSpecs: req.pathSpecs.slice(0, 2),
      });
    }

    const data = res.data
      .map((row): BathymetryData | undefined => {
        const [timestamp, position, depth, heading] = row;
        const [latitude, longitude] = position || [];

        if (depth !== null && longitude !== null && latitude !== null) {
          return {
            timestamp: Temporal.Instant.from(timestamp),
            longitude,
            latitude,
            depth,
            heading,
          };
        }
      })
      .filter(Boolean);

    app.debug("Read %d bathymetry points from history", data.length);

    if (data.length === 0) return;

    return Readable.from(data);
  }

  /**
   * Get the list of dates that there is data for in the history.
   *
   * @param to - The end date of the range to get available dates for, defaults to now
   * @param from - The start date of the range to get available dates for, defaults to epoch
   */
  async function getAvailableDates({
    to = Temporal.Now.instant(),
    from = Temporal.Instant.fromEpochMilliseconds(0),
  } = {}) {
    // @ts-expect-error: https://github.com/SignalK/signalk-server/pull/2264
    const res = await history.getValues({
      from,
      to,
      resolution: 86400, // 1 day
      pathSpecs: [
        {
          path: ("environment.depth." + config.path) as Path,
          // signalk-to-influxdb returns null when requesting `first`, so using `min` instead
          aggregate: "min",
        },
      ],
    });

    // Get days with depth data
    return res.data
      .filter(([, v]) => v)
      .map((row) => Temporal.Instant.from(row[0]));
  }

  return {
    // History providers handle the recording of data themselves
    createWriter: undefined,
    createReader,
    getAvailableDates,
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
      from: Temporal.Instant.fromEpochMilliseconds(0),
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
