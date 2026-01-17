import { Config } from "../config.js";
import { Readable } from "stream";
import { BathymetryData, BathymetrySource, Timeframe } from "../types.js";
import { Path, ServerAPI } from "@signalk/server-api";
import {
  ContextsRequest,
  ContextsResponse,
  HistoryApi,
  PathSpec,
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
    const timerange = {
      from: toTemporalInstant(from),
      to: toTemporalInstant(to),
    };

    // @ts-expect-error: https://github.com/SignalK/signalk-server/pull/2264
    const availablePaths = await history.getPaths(timerange);

    const pathSpecs: PathSpec[] = [
      { path: "navigation.position" as Path, aggregate: "first" },
      {
        path: `environment.depth.${config.path}` as Path,
        aggregate: "first",
      },
    ];

    // API returns an error if you request a path that doesn't exist
    // https://github.com/tkurki/signalk-to-influxdb2/issues/99
    if (availablePaths.includes("navigation.headingTrue" as Path)) {
      pathSpecs.push({
        path: "navigation.headingTrue" as Path,
        aggregate: "first",
      });
    }

    // @ts-expect-error: https://github.com/SignalK/signalk-server/pull/2264
    const res = await history.getValues({
      ...timerange,
      resolution: 1, // 1 second
      pathSpecs,
    });

    const data = res.data
      .map((row): BathymetryData | undefined => {
        const [timestamp, [longitude, latitude], depth, heading] = row;

        if (depth !== null && longitude !== null && latitude !== null) {
          return {
            timestamp: new Date(timestamp),
            longitude,
            latitude,
            depth,
            heading,
          };
        }
      })
      .filter(Boolean);

    app.debug("Read %d bathymetry points from history", data.length);

    return Readable.from(data);
  }

  /**
   * Get the list of dates that there is data for in the history.
   *
   * @param to - The end date of the range to get available dates for, defaults to now
   * @param from - The start date of the range to get available dates for, defaults to `new Date(0)`
   */
  async function getAvailableDates({
    to = new Date(),
    from = new Date(0),
  } = {}) {
    // @ts-expect-error: https://github.com/SignalK/signalk-server/pull/2264
    const res = await history.getValues({
      from: toTemporalInstant(from),
      to: toTemporalInstant(to),
      resolution: 86400, // 1 day
      pathSpecs: [
        {
          path: ("environment.depth." + config.path) as Path,
          aggregate: "first",
        },
      ],
    });

    return res.data.map((row) => new Date(row[0]));
  }

  return {
    // History providers handle the recording of data themselves
    createWriter: undefined,
    createReader,
    getAvailableDates,
  };
}

export interface HistorySourceOptions {
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
  host = process.env.SIGNALK_HOST ?? "http://localhost:3000/",
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
    await getContexts();
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

function toTemporalInstant(date: Date): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime());
}
