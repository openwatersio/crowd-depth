// Tide for the live layer: each sounding's predicted water level above its station's
// chart datum, from the Slackwater API that signalk-tides mounts, chosen and widened as
// the grid's (packages/grid/src/grid/tide.py and catalog.py). Each 0.02° tide cell takes
// the nearest eligible station within the grid's reach of its centre, so the boat
// reduces its soundings with the station the grid uses for the same water.
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { Transform } from "node:stream";
import { ServerAPI } from "@signalk/server-api";
import { BathymetryData } from "../types.js";
import { DEFINITIONS } from "./geometry.js";

const T = DEFINITIONS.tide;

/** A sounding's water level above chart datum and its uncertainty, in metres. */
export interface Tide {
  level: number;
  sigma: number;
}

/** A Slackwater station as its listings give it: where it is. */
interface Listed {
  id: string;
  latitude: number;
  longitude: number;
}

/** The fields of a Slackwater station's details the reduction reads. */
export interface Station extends Listed {
  chart_datum?: string;
  datums?: Record<string, number>;
  license?: { commercial_use?: boolean };
  quality?: { accepted?: boolean };
}

/** A failed request: the status, and whether the server answered it as the API does,
 * with JSON, rather than as a server without the API mounted. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public json = false,
  ) {
    super(message);
  }
}

/** Fetch JSON from a path under the tides API; rejects with an {@link ApiError}. */
export type GetJson = (path: string) => Promise<unknown>;

const TIMEOUT_MS = 5_000;
/** Timelines kept: a station day each, about 150 levels. */
const MAX_TIMELINES = 256;
const MAX_KEPT = 4096;
const DAY_MS = 86_400_000;
const EARTH_KM = 6371;

/** A station levels may come from, by the grid's rule (`tide.eligible`): openly
 * licensed, accepted, with levels on a chart datum, and not a lake gauge, whose lowest
 * low water comes from its level record rather than the tide. */
export function eligible(s: Station): boolean {
  const range = (s.datums?.MHHW ?? NaN) - (s.datums?.MLLW ?? NaN);
  const lake = s.chart_datum === "LLWLT" && range < T.lake_range_m;
  return (
    s.license?.commercial_use === true &&
    s.quality?.accepted !== false &&
    s.chart_datum !== undefined &&
    T.chart_datums.includes(s.chart_datum) &&
    s.datums?.[s.chart_datum] != null &&
    !lake
  );
}

/** Great-circle kilometres between two points. */
export function km(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) *
      Math.cos(lat2 * r) *
      Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A level's uncertainty from its distance to the station, as the grid's: a prediction
 * without a gauge, widened per km. */
export function tideSigma(stationKm: number): number {
  return Math.hypot(T.predicted_sigma_m, stationKm * T.sigma_per_km);
}

/** Whether signalk-tides is installed beside this plugin, among the server's plugins or
 * this plugin's own modules. Installed doesn't mean running: it may be off, or not
 * started yet. */
export function tidesInstalled(app: ServerAPI): boolean {
  const configPath = (app as unknown as { config?: { configPath?: string } })
    .config?.configPath;
  const from = [import.meta.url];
  if (configPath) from.unshift(path.join(configPath, "package.json"));
  return from.some((at) => {
    try {
      createRequire(at).resolve("signalk-tides");
      return true;
    } catch {
      return false;
    }
  });
}

/** The tides API on this Signal K server, over its loopback interface. */
export function tidesUrl(app: ServerAPI): string {
  const settings =
    (app as unknown as { config?: { settings?: Record<string, unknown> } })
      .config?.settings ?? {};
  // As the server's own ports: with SSL on, its HTTP port only redirects.
  const port = settings.ssl
    ? Number(process.env.SSLPORT) || Number(settings.sslport) || 3443
    : Number(process.env.PORT) || Number(settings.port) || 3000;
  return `${settings.ssl ? "https" : "http"}://127.0.0.1:${port}/signalk/v2/api/tides`;
}

/** GET JSON from the tides API at `base`. The server's own certificate is often
 * self-signed, and it's this server on loopback, sent nothing but public tide queries,
 * so the certificate isn't checked. */
export function httpJson(base: string): GetJson {
  return (path) =>
    new Promise((resolve, reject) => {
      const url = base + path;
      const done = (res: http.IncomingMessage) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          let json: unknown;
          let parsed = false;
          try {
            json = JSON.parse(body);
            parsed = true;
          } catch {
            // Not the API's answer.
          }
          if (res.statusCode === 200 && parsed) resolve(json);
          else {
            reject(
              new ApiError(
                `${res.statusCode} from ${url}`,
                res.statusCode,
                parsed,
              ),
            );
          }
        });
        res.on("error", reject);
      };
      const req = url.startsWith("https:")
        ? https.get(
            url,
            { timeout: TIMEOUT_MS, rejectUnauthorized: false },
            done,
          )
        : http.get(url, { timeout: TIMEOUT_MS }, done);
      req.on("timeout", () => req.destroy(new ApiError(`timed out: ${url}`)));
      req.on("error", (err) =>
        reject(err instanceof ApiError ? err : new ApiError(String(err))),
      );
    });
}

/** The API answered, in JSON as it does, that it can't predict a station's day. */
const dayFailed = (err: unknown) =>
  err instanceof ApiError &&
  err.json &&
  (err.status === 400 || err.status === 500);

/** The API answered, in JSON as it does, that it has no such station. */
const noStation = (err: unknown) =>
  err instanceof ApiError && err.json && err.status === 404;

/** Keep a map from growing past `max`, dropping its oldest entry. */
const keep = <K, V>(map: Map<K, V>, max = MAX_KEPT) => {
  if (map.size > max) map.delete(map.keys().next().value!);
};

export type Tides = ReturnType<typeof createTides>;

/**
 * Tide levels for soundings, from signalk-tides. Requests are few: the stations of each
 * square degree the boat's soundings fall in, each station's details as it's chosen, and
 * a timeline per station per UTC day, all kept.
 */
export function createTides(get: GetJson, { now = Date.now } = {}) {
  const regions = new Map<string, Promise<Listed[]>>();
  const details = new Map<string, Promise<Station>>();
  /** Stations passed over for good: gone, or not eligible. */
  const passed = new Set<string>();
  /** Station days without levels the reduction can use, which go untided, as the grid
   * leaves a station day without whole levels out. */
  const failed = new Map<string, true>();
  /** Each tide cell's stations within the grid's reach of its centre, nearest first. */
  const candidates = new Map<number, { id: string; km: number }[]>();
  const timelines = new Map<string, Promise<[number, number][] | null>>();
  let started: Promise<boolean> | undefined;
  let up = false;

  /** A request's answer, kept; a failure is asked again rather than kept. */
  const kept = <V>(
    map: Map<string, Promise<V>>,
    key: string,
    load: () => Promise<V>,
    max = MAX_KEPT,
  ) => {
    let value = map.get(key);
    if (!value) {
      value = load();
      map.set(key, value);
      value.catch(() => map.delete(key));
      keep(map, max);
    }
    return value;
  };

  /** The stations of the square degree holding a point, with a margin past the grid's
   * reach on every side, so any point in it finds every station in reach.
   * ponytail: clipped at the antimeridian, so a station across it is out of reach. */
  const region = (lat: number, lon: number) => {
    const lat0 = Math.floor(lat);
    const lon0 = Math.floor(lon);
    const poleward = Math.min(Math.max(Math.abs(lat0), Math.abs(lat0 + 1)), 89);
    const pad = 0.5 / Math.cos((poleward * Math.PI) / 180);
    const box = [
      Math.max(lon0 - pad, -180),
      Math.max(lat0 - 0.5, -90),
      Math.min(lon0 + 1 + pad, 180),
      Math.min(lat0 + 1.5, 90),
    ];
    return kept(
      regions,
      `${lat0},${lon0}`,
      () => get(`/stations?bbox=${box.join(",")}`) as Promise<Listed[]>,
    );
  };

  /** A station's details, or null once it's passed over for good. */
  const station = async (stationId: string): Promise<Station | null> => {
    if (passed.has(stationId)) return null;
    const [source, id] = split(stationId);
    try {
      const s = await kept(
        details,
        stationId,
        () => get(`/stations/${source}/${id}`) as Promise<Station>,
      );
      if (eligible(s)) return s;
    } catch (err) {
      if (!noStation(err)) throw err;
    }
    passed.add(stationId);
    return null;
  };

  /** A station's level at a time (epoch ms), or null when the engine can't give one the
   * reduction can use: an error in JSON for the day, as where Slackwater threw on the
   * station's harmonics, or levels on another datum, in other units or with holes. */
  const level = async (s: Station, time: number): Promise<number | null> => {
    const day = Math.floor(time / DAY_MS);
    const start = new Date(day * DAY_MS).toISOString();
    const end = new Date((day + 1) * DAY_MS).toISOString();
    const [source, id] = split(s.id);
    let series: [number, number][] | null;
    try {
      // The oldest goes first: a backfill moves forward through its days.
      series = await kept(
        timelines,
        `${s.id}/${day}`,
        async () => {
          const body = (await get(
            `/stations/${source}/${id}/timeline?start=${start}&end=${end}`,
          )) as {
            datum?: string;
            units?: string;
            timeline: { time: string; level: number }[];
          };
          // Levels on another datum or in other units, or a day with holes, would reduce
          // to the wrong depth: the station is passed over for the day instead.
          const series = Array.isArray(body.timeline)
            ? body.timeline.map(
                (e) => [Date.parse(e.time), e.level] as [number, number],
              )
            : [];
          return body.datum === s.chart_datum &&
            body.units === "meters" &&
            series.length > 0 &&
            series.every(([t, l]) => Number.isFinite(t) && Number.isFinite(l))
            ? series
            : null;
        },
        MAX_TIMELINES,
      );
    } catch (err) {
      // The API's own answer for this station's day: a 500 where Slackwater threw on its
      // harmonics, or a 400. Anything else, a refusal or the server's, is asked again.
      if (!dayFailed(err)) throw err;
      series = null;
    }
    return (series && interpolate(series, time)) ?? null;
  };

  return {
    /** The tide at a point and time (epoch ms); null where no eligible station in reach
     * has a level; undefined before signalk-tides has answered {@link ready}, or for a
     * request it didn't answer. Never rejects. */
    async at(
      lon: number,
      lat: number,
      time: number,
    ): Promise<Tide | null | undefined> {
      if (!up) return undefined;
      // The grid's tide cell, and its centre, where stations are chosen from.
      const n = T.cells_per_degree;
      const cy = Math.floor((lat + 90) * n);
      const cx = Math.floor(((((lon + 180) % 360) + 360) % 360) * n);
      const cell = cy * 360 * n + cx;
      const day = Math.floor(time / DAY_MS);
      try {
        let near = candidates.get(cell);
        if (!near) {
          const cLat = (cy + 0.5) / n - 90;
          const cLon = (cx + 0.5) / n - 180;
          near = (await region(cLat, cLon))
            .map((s) => ({
              id: s.id,
              km: km(cLat, cLon, s.latitude, s.longitude),
            }))
            .filter((c) => c.km <= T.station_km)
            .sort((a, b) => a.km - b.km);
          candidates.set(cell, near);
          keep(candidates);
        }
        // The nearest eligible station. A day it has no levels for goes untided rather
        // than to another station, as in the grid, which gives a station's water away
        // only once it predicts nothing at all.
        for (const c of near) {
          const s = await station(c.id);
          if (!s) continue;
          if (failed.has(`${s.id}/${day}`)) return null;
          const found = await level(s, time);
          if (found !== null) return { level: found, sigma: tideSigma(c.km) };
          failed.set(`${s.id}/${day}`, true);
          keep(failed);
          return null;
        }
        return null;
      } catch {
        // signalk-tides lives in this server, so it stops answering only while it's
        // restarted or turned off: this sounding goes untided, and the next asks again.
        return undefined;
      }
    },

    /** Whether signalk-tides answers, asked every few seconds for up to `waitMs`, as it
     * may start after this plugin: once, when the layer starts, and the same answer
     * after. Until it has answered, nothing else is asked. Rejects with the last failure
     * when it never does, so the caller can say why. */
    ready(
      waitMs: number,
      {
        everyMs = 5_000,
        signal,
      }: { everyMs?: number; signal?: AbortSignal } = {},
    ): Promise<boolean> {
      started ??= (async () => {
        const until = now() + waitMs;
        for (;;) {
          try {
            await get("/");
            return (up = true);
          } catch (err) {
            if (signal?.aborted || now() + everyMs > until) throw err;
            await new Promise((r) => setTimeout(r, everyMs));
          }
        }
      })();
      return started;
    },
  };
}

/** A station id's source and id, each encoded for a path, as `/stations/:source/:id`. */
function split(stationId: string): [string, string] {
  const slash = stationId.indexOf("/");
  return [
    encodeURIComponent(stationId.slice(0, slash)),
    encodeURIComponent(stationId.slice(slash + 1)),
  ];
}

/** The level at `time` in a series of [epoch ms, level], linear between its points; or
 * undefined outside it. */
export function interpolate(
  series: [number, number][],
  time: number,
): number | undefined {
  let lo = 0;
  let hi = series.length - 1;
  if (hi < 0 || time < series[0][0] || time > series[hi][0]) return undefined;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= time) lo = mid;
    else hi = mid;
  }
  const [t0, l0] = series[lo];
  const [t1, l1] = series[hi];
  return t1 === t0 ? l0 : l0 + ((l1 - l0) * (time - t0)) / (t1 - t0);
}

/** Each sounding with its tide, where it has one. QC judges the raw depths; the writer
 * reduces them as they go into passes. */
export function withTide(tides: Tides): Transform {
  return new Transform({
    objectMode: true,
    transform(data: BathymetryData, _encoding, callback) {
      void tides
        .at(data.longitude, data.latitude, data.timestamp.epochMilliseconds)
        .then((tide) => callback(null, tide ? { ...data, tide } : data));
    },
  });
}
