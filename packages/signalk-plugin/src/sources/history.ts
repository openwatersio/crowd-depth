import { sameSource } from "../device-info.js";
import {
  GNSS_FIELDS,
  qualityValue,
  type GnssQuality,
} from "../gnss-quality.js";
import { gnssOrigin } from "../gnss-offsets.js";
import { Config, depthReference } from "../config.js";
import { Readable } from "stream";
import { BathymetryData, BathymetrySource, Timeframe } from "../types.js";
import { Path, ServerAPI, SourceRef } from "@signalk/server-api";
import {
  ContextsRequest,
  ContextsResponse,
  DataRow,
  HistoryApi,
  PathsRequest,
  PathsResponse,
  ValuesRequest,
  ValuesResponse,
} from "@signalk/server-api/history";
import { Temporal } from "@js-temporal/polyfill";
import { BATHY_EPOCH } from "../constants.js";
import fetch from "../fetch.js";
import { setTimeout as sleep } from "node:timers/promises";
import { bowBearing } from "../streams/transforms.js";

const HEADING = "navigation.headingTrue";
const COG = "navigation.courseOverGroundTrue";
const SOG = "navigation.speedOverGround";

export async function createHistorySource(
  app: ServerAPI,
  config: Config,
  options: HistorySourceOptions = {},
): Promise<BathymetrySource | undefined> {
  const history = await getHistoryAPI({ app, ...options });

  if (!history) return;
  function checkSourceSelection() {
    if (
      history?.supportsSourceSelection === false &&
      (config.gnss?.source || config.sounder?.source)
    ) {
      throw new Error(
        "Legacy HTTP history cannot filter sensor sources. Select Preferred source for both sensors or use a source-aware History API provider. Reporting is paused; recorded data and the reporting checkpoint are unchanged.",
      );
    }
  }

  let qualityPending = false;

  async function createReader({ from, to }: Timeframe) {
    checkSourceSelection();
    app.debug("Reading history from %s to %s", from, to);

    // An unspecified source uses the provider's recorded default series, not
    // whichever device happens to be preferred on the boat at upload time.
    const depthPath = `environment.depth.${config.path}`;
    const positionSource = config.gnss?.source;
    const depthSource = config.sounder?.source;
    // The provider stores the depth as Signal K received it; apply the same
    // offset the live stream applies before writing, so both sources report
    // depths measured from the same reference.
    const { offset } = depthReference(config);

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
        // Heading, or COG while making way, moves each sounding from the
        // antenna to the transducer. `min` rather than `average`: averaging
        // angles either side of north points the bow south, and the slowest
        // speed in a bucket is the safe one to test against.
        ...[HEADING, COG, SOG].map((path) => ({
          path: path as Path,
          aggregate: "min" as const,
          parameter: [],
        })),
      ],
    };

    let res: ValuesResponse;
    let pathSpecs = req.pathSpecs;
    try {
      res = await history!.getValues(req);
    } catch {
      // The provider throws if a requested path doesn't exist, so retry with
      // only the orientation paths it has recorded.
      // https://github.com/tkurki/signalk-to-influxdb2/issues/99
      const recorded: string[] = await Promise.resolve()
        .then(() => history!.getPaths({ from, to }))
        .catch(() => []);
      pathSpecs = req.pathSpecs.filter(
        (spec, i) => i < 2 || recorded.includes(spec.path),
      );
      res = await history!.getValues({ ...req, pathSpecs });
    }

    // Quality is optional: unsupported string aggregates must not block bathymetry.
    let qualityResponse = res;
    if (options.includeQuality !== false && !qualityPending) {
      qualityPending = true;
      const lookup = (async () => {
        const recorded = await history!.getPaths({ from, to });
        const specs = Object.keys(GNSS_FIELDS)
          .map((field) => ({
            path: `navigation.gnss.${field}` as Path,
            aggregate: "first" as const,
            parameter: [],
            ...(positionSource
              ? { sourceRef: positionSource as SourceRef }
              : {}),
          }))
          .filter((spec) => recorded.includes(spec.path));
        if (specs.length) {
          try {
            return await history!.getValues({ ...req, pathSpecs: specs });
          } catch (error) {
            const numeric = specs.filter(
              (spec) =>
                GNSS_FIELDS[
                  spec.path.slice(
                    "navigation.gnss.".length,
                  ) as keyof typeof GNSS_FIELDS
                ] === "number",
            );
            if (numeric.length && numeric.length < specs.length)
              return await history!.getValues({ ...req, pathSpecs: numeric });
            throw error;
          }
        }
      })()
        .catch((error) => {
          app.debug("Historical GPS quality unavailable: %s", error);
        })
        .finally(() => {
          qualityPending = false;
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        lookup,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 2000);
        }),
      ]);
      clearTimeout(timer);
      if (response) qualityResponse = response;
    }
    const qualityColumns = columnsByPath(qualityResponse.values, []);
    const qualityRows = new Map(
      qualityResponse.data.map((row) => [row[0], row]),
    );

    // Map columns by path rather than position: the provider may reorder them
    // or omit one entirely when a bucket has no data for it.
    const columns = columnsByPath(res.values, pathSpecs);
    const positionColumn = columns.get("navigation.position");
    const depthColumn = columns.get(depthPath);
    const column = (row: DataRow, path: string) => {
      const index = columns.get(path);
      const value = index === undefined ? undefined : row[index];
      return typeof value === "number" ? value : undefined;
    };

    const positionOrigin = gnssOrigin(
      app,
      config,
      positionSource ||
        res.values?.find((value) => value.path === "navigation.position")
          ?.$source,
    );
    if (res.data.length && !positionOrigin)
      throw new Error(
        "GPS geometry unavailable for historical positions. Configure the selected receiver in Signal K GNSS sensor settings; use a source-aware history provider and select an explicit source if history does not identify it. Use off/both correction mode.",
      );

    const data = res.data
      .map((row): BathymetryData | undefined => {
        const depth = depthColumn === undefined ? undefined : row[depthColumn];
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
          const timestamp = Temporal.Instant.from(row[0]);
          const gnss: GnssQuality = {};
          for (const field of Object.keys(
            GNSS_FIELDS,
          ) as (keyof typeof GNSS_FIELDS)[]) {
            const qualityPath = `navigation.gnss.${field}`;
            const qualitySource = qualityResponse.values?.find(
              (value) => value.path === qualityPath,
            )?.$source;
            const receiver =
              positionSource ||
              res.values?.find((value) => value.path === "navigation.position")
                ?.$source;
            // An unfiltered default quality series can belong to another receiver.
            if (
              !positionSource &&
              (!receiver ||
                !qualitySource ||
                !sameSource(app, receiver, qualitySource))
            )
              continue;
            const index = qualityColumns.get(qualityPath);
            const qualityRow = qualityRows.get(row[0]);
            const value =
              index === undefined || !qualityRow
                ? undefined
                : qualityValue(field, qualityRow[index]);
            if (value !== undefined) gnss[field] = value;
          }
          const local = options.quality?.(
            { timestamp, longitude, latitude, depth },
            positionSource ||
              res.values?.find((value) => value.path === "navigation.position")
                ?.$source,
          );
          const quality = local ?? gnss;
          return {
            timestamp,
            ...(Object.keys(quality).length ? { gnss: quality } : {}),
            longitude,
            latitude,
            depth: depth + offset,
            positionOrigin,
            heading: bowBearing({
              heading: column(row, HEADING),
              courseOverGround: column(row, COG),
              speedOverGround: column(row, SOG),
            }),
          };
        }
      })
      .filter((point): point is BathymetryData => point !== undefined)
      // Providers include `to`, but the next report starts there, so leave the
      // bucket stamped `to` for it.
      .filter((point) => Temporal.Instant.compare(point.timestamp, to) < 0);

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
    checkSourceSelection();
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

export interface WaitOptions {
  timeout: Temporal.Duration;
  interval?: Temporal.Duration;
  signal?: AbortSignal;
}

/**
 * Keeps looking for a history source until one appears or the timeout passes.
 * Plugins start in no particular order, and a provider registers only once its
 * plugin is up, so one that is missing at startup may just not be ready yet.
 */
export async function waitForHistorySource(
  find: () => Promise<BathymetrySource | undefined>,
  {
    timeout,
    interval = Temporal.Duration.from({ seconds: 5 }),
    signal,
  }: WaitOptions,
): Promise<BathymetrySource | undefined> {
  const deadline = Date.now() + timeout.total("milliseconds");
  for (;;) {
    if (signal?.aborted) return;
    const source = await find();
    if (source) return source;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    try {
      await sleep(
        Math.min(interval.total("milliseconds"), remaining),
        undefined,
        {
          signal,
        },
      );
    } catch {
      return;
    }
  }
}

export interface HistorySourceOptions {
  includeQuality?: boolean;
  quality?: (point: BathymetryData, source?: string) => GnssQuality | undefined;
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
}: HistoryAPIOptions): Promise<
  (HistoryApi & { supportsSourceSelection?: boolean }) | undefined
> {
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

  return { getValues, getContexts, getPaths, supportsSourceSelection: false };

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
