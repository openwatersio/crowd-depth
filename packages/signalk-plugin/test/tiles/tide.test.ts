import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import nock from "nock";
import { expect, test } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import definitions from "../../src/definitions.json" with { type: "json" };
import { createDB } from "../../src/storage.js";
import { historySpan } from "../../src/config.js";
import {
  addPass,
  cellDepth,
  cellSigma,
  createCellStore,
  createCellWriter,
} from "../../src/tiles/index.js";
import {
  ApiError,
  createTides,
  httpJson,
  withTide,
  eligible,
  interpolate,
  km,
  tideSigma,
  type Station,
} from "../../src/tiles/tide.js";
import type { BathymetryData } from "../../src/types.js";

const T = definitions.tide;
const S = definitions.statistic;
const DAY_MS = 86_400_000;

/** A station as the Slackwater API lists it. */
const station = (id: string, latitude: number, longitude: number, more = {}) =>
  ({
    id,
    latitude,
    longitude,
    chart_datum: "MLLW",
    datums: { MLLW: 1.377, MHHW: 1.815 },
    license: { commercial_use: true },
    ...more,
  }) as Station;

/** A fake tides API: stations listed by bounding box with their details by id, and
 * for each a level rising 0.1 m an hour from 0 at each UTC midnight, every 10 minutes.
 * `unpredictable` stations answer their timelines with a 500, as the API does when Slackwater throws. */
function fakeApi(
  stations: Station[],
  { fail = false, unpredictable = [] as string[], holes = [] as string[] } = {},
) {
  const calls: string[] = [];
  const get = async (path: string) => {
    calls.push(path);
    if (fail) throw new ApiError("no answer");
    const url = new URL(path, "http://x");
    if (url.pathname === "/") return { name: "Slackwater" };
    if (url.pathname === "/stations") {
      const [w, s, e, n] = url.searchParams.get("bbox")!.split(",").map(Number);
      return stations
        .filter(
          (st) =>
            st.longitude >= w &&
            st.longitude <= e &&
            st.latitude >= s &&
            st.latitude <= n,
        )
        .map(({ id, latitude, longitude }) => ({ id, latitude, longitude }));
    }
    const [, , source, id, what] = url.pathname.split("/");
    const station = stations.find((st) => st.id === `${source}/${id}`);
    if (!station) throw new ApiError("404", 404, true);
    if (!what) return station;
    if (unpredictable.includes(station.id))
      throw new ApiError("500", 500, true);
    const start = Date.parse(url.searchParams.get("start")!);
    return {
      datum: station.chart_datum,
      units: "meters",
      timeline: Array.from({ length: 145 }, (_, i) => ({
        time: new Date(start + i * 600_000).toISOString(),
        level: holes.includes(station.id) && i === 70 ? null : (i / 6) * 0.1,
      })),
    };
  };
  return { get, calls };
}

const annapolis = station("noaa/8575512", 38.9839, -76.48);

/** A tides client that has found signalk-tides answering, as the layer's start does. */
async function started(get: (path: string) => Promise<unknown>) {
  const tides = createTides(get);
  await tides.ready(0);
  return tides;
}
const noon = Date.parse("2026-10-19T12:00:00Z");

test("a sounding's tide is its station's level at its time, widened by distance", async () => {
  const api = fakeApi([annapolis]);
  const tides = await started(api.get);
  const tide = await tides.at(-76.45, 38.95, noon + 15 * 60_000);
  // 12¼ hours after midnight, between two 10-minute levels.
  expect(tide!.level).toBeCloseTo(1.225, 6);
  // Distance from the 0.02° tide cell's centre, as the grid measures it.
  const d = km(38.95, -76.45, annapolis.latitude, annapolis.longitude);
  expect(tide!.sigma).toBeGreaterThan(T.predicted_sigma_m);
  expect(tide!.sigma).toBeCloseTo(tideSigma(d), 2);
  expect(tideSigma(0)).toBe(T.predicted_sigma_m);
  expect(tideSigma(40)).toBeCloseTo(Math.hypot(0.25, 40 * T.sigma_per_km), 9);
});

test("stations and timelines are fetched once and kept", async () => {
  const api = fakeApi([annapolis, station("noaa/8574680", 39.2667, -76.5783)]);
  const tides = await started(api.get);
  // A 30-day track up the bay, a sounding a minute.
  for (let t = 0; t < 30 * DAY_MS; t += 60_000) {
    await tides.at(-76.48, 38.9 + (t / (30 * DAY_MS)) * 0.4, noon + t);
  }
  const lists = api.calls.filter((c) => c.startsWith("/stations?"));
  const timelines = api.calls.filter((c) => c.includes("/timeline"));
  // One list per square degree, across 39°N, and each station's details once.
  expect(lists).toHaveLength(2);
  expect(
    api.calls.filter((c) => /^\/stations\/noaa\/\d+$/.test(c)),
  ).toHaveLength(2);
  // A timeline per station per day, at most.
  expect(timelines.length).toBeLessThanOrEqual(2 * 31);
  expect(new Set(timelines).size).toBe(timelines.length);
  expect(api.calls.length).toBeLessThan(100);
});

test("water with no eligible station in reach stays untided", async () => {
  const api = fakeApi([
    annapolis,
    station("lake/1", 30.01, -50.01, {
      chart_datum: "LLWLT",
      datums: { LLWLT: 0, MLLW: 0, MHHW: 0.1 },
    }),
    station("ugly/1", 30.02, -50.02, { license: { commercial_use: false } }),
    station("std/1", 30.03, -50.03, { chart_datum: "STND" }),
  ]);
  const tides = await started(api.get);
  expect(await tides.at(-50, 30, noon)).toBeNull();
  // Past the grid's reach of the station.
  expect(await tides.at(-76.48, 38.98 + 0.6, noon)).toBeNull();
  expect(eligible(annapolis)).toBe(true);
});

test("the nearest eligible station is found past any number of ineligible ones", async () => {
  const ugly = Array.from({ length: 150 }, (_, i) =>
    station(`ugly/${i}`, 38.95 + i * 0.0001, -76.45, {
      license: { commercial_use: false },
    }),
  );
  const tides = await started(fakeApi([...ugly, annapolis]).get);
  expect((await tides.at(-76.45, 38.95, noon))!.level).toBeCloseTo(1.2, 6);
});

test("a day the station can't be predicted goes untided, as in the grid", async () => {
  const near = station("noaa/1", 38.95, -76.45);
  const api = fakeApi([near, annapolis], { unpredictable: ["noaa/1"] });
  const tides = await started(api.get);
  expect(await tides.at(-76.45, 38.95, noon)).toBeNull();
  // Not asked again that day, and not given to Annapolis.
  expect(await tides.at(-76.45, 38.95, noon + 60_000)).toBeNull();
  expect(
    api.calls.filter((c) => c.startsWith("/stations/noaa/1/")),
  ).toHaveLength(1);
  expect(api.calls.some((c) => c.includes("8575512/timeline"))).toBe(false);
});

test("nothing is asked until signalk-tides has answered at start, and never if it doesn't", async () => {
  const api = fakeApi([annapolis], { fail: true });
  const tides = createTides(api.get);
  expect(await tides.at(-76.48, 38.98, noon)).toBeUndefined();
  expect(api.calls).toHaveLength(0);
  await expect(tides.ready(0)).rejects.toThrow();
  // The start's answer stands: not asked again.
  await expect(tides.ready(0)).rejects.toThrow();
  expect(await tides.at(-76.48, 38.98, noon)).toBeUndefined();
  expect(api.calls).toHaveLength(1);
});

/** A fake API that can be switched off and on, as signalk-tides restarting. */
function switchable(stations: Station[]) {
  const api = fakeApi(stations);
  let up = true;
  return {
    calls: api.calls,
    set: (on: boolean) => (up = on),
    get: (path: string) =>
      up ? api.get(path) : Promise.reject(new ApiError("no answer")),
  };
}

const sounding = (t = noon) => ({
  latitude: 38.98,
  longitude: -76.48,
  depth: 5,
  timestamp: Temporal.Instant.fromEpochMilliseconds(t),
});

/** What a stream of soundings comes out of `withTide` as. */
async function annotate(
  stream: ReturnType<typeof withTide>,
  data: BathymetryData[],
) {
  const out: BathymetryData[] = [];
  await pipeline(
    Readable.from(data),
    stream,
    new Writable({
      objectMode: true,
      write: (d, _e, cb) => (out.push(d), cb()),
    }),
  );
  return out;
}

test("a sounding signalk-tides doesn't answer for mid-run goes untided, and the next asks again", async () => {
  const api = switchable([annapolis]);
  const tides = await started(api.get);
  let [out] = await annotate(withTide(tides), [sounding()]);
  expect(out.tide).toBeDefined();
  // Restarted by its owner: a new day's timeline isn't there to fetch.
  api.set(false);
  [out] = await annotate(withTide(tides), [sounding(noon + 3 * DAY_MS)]);
  expect(out.tide).toBeUndefined();
  api.set(true);
  [out] = await annotate(withTide(tides), [sounding(noon + 3 * DAY_MS)]);
  expect(out.tide).toBeDefined();
});

test("the HTTP client tells the API's answers from a server without it", async () => {
  const base = "http://127.0.0.1:3999/signalk/v2/api/tides";
  nock("http://127.0.0.1:3999")
    .get("/signalk/v2/api/tides/stations/noaa/1")
    .reply(200, { id: "noaa/1" })
    .get("/signalk/v2/api/tides/stations/noaa/2")
    .reply(404, { message: "Station not found: noaa/2" })
    .get("/signalk/v2/api/tides/")
    .reply(404, "<pre>Cannot GET /signalk/v2/api/tides/</pre>")
    .get("/signalk/v2/api/tides/stations")
    .reply(401, "Unauthorized");
  const get = httpJson(base);
  expect(await get("/stations/noaa/1")).toEqual({ id: "noaa/1" });
  await expect(get("/stations/noaa/2")).rejects.toMatchObject({
    status: 404,
    json: true,
  });
  await expect(get("/")).rejects.toMatchObject({ status: 404, json: false });
  await expect(get("/stations")).rejects.toMatchObject({ status: 401 });
  nock.cleanAll();
});

test("levels interpolate linearly, and not past their series", () => {
  const series: [number, number][] = [
    [0, 1],
    [10, 2],
    [20, 0],
  ];
  expect(interpolate(series, 5)).toBe(1.5);
  expect(interpolate(series, 15)).toBe(1);
  expect(interpolate(series, 21)).toBeUndefined();
  expect(interpolate([], 0)).toBeUndefined();
});

test("a tided cell's σ uses the tide's uncertainty instead of the untided σ", () => {
  const untided = addPass(undefined, { py: 0, px: 0, depth: 10, day: 1 });
  const tided = addPass(undefined, {
    py: 0,
    px: 0,
    depth: 10,
    day: 1,
    tide: 0.25,
  });
  expect(untided.t).toBeUndefined();
  expect(cellSigma(untided)).toBeCloseTo(
    Math.hypot(S.untided_sigma_m, S.uncalibrated_sigma_m, 0.375),
    9,
  );
  expect(cellSigma(tided)).toBeCloseTo(
    Math.hypot(0.25, S.uncalibrated_sigma_m, 0.375),
    9,
  );
  expect(cellDepth(tided)).toBeGreaterThan(cellDepth(untided));
});

test("a tided pass starts an untided cell afresh; an untided one leaves a tided cell be", () => {
  let cell = addPass(undefined, { py: 0, px: 0, depth: 11, day: 1 });
  cell = addPass(cell, { py: 0, px: 0, depth: 12, day: 2 });
  cell = addPass(cell, { py: 0, px: 0, depth: 10, day: 3, tide: 0.3 });
  expect(cell).toMatchObject({ m: 10, d: 0.3, t: 0.3, passes: 1, first: 3 });
  // Raw passes at high water, as while signalk-tides is stopped, many times over.
  for (let i = 0; i < 50; i++) {
    cell = addPass(cell, { py: 0, px: 0, depth: 14, day: 4 });
  }
  expect(cell).toMatchObject({ m: 10, t: 0.3, passes: 1 });
  cell = addPass(cell, { py: 0, px: 0, depth: 10.5, day: 5, tide: 0.25 });
  expect(cell.m).toBeCloseTo(10.1, 9);
  expect(cell.t).toBeCloseTo(0.29, 9);
  expect(cell.passes).toBe(2);
});

test("the store keeps a cell's tide σ, rounded up, and untided as untided", () => {
  const store = createCellStore(createDB(":memory:"));
  store.addPasses([
    { py: 10, px: 10, depth: 5, day: 1, tide: 0.251 },
    { py: 10, px: 11, depth: 5, day: 1 },
  ]);
  const [a, b] = store.cells(-180, -90, 180, 90).sort((x, y) => x.px - y.px);
  expect(a.t).toBe(0.26);
  expect(b.t).toBeUndefined();
  // An overview block holding both says it holds an untided cell, whichever it shows,
  // built live or rebuilt.
  const check = () => {
    const blocks = store.cells(-180, -90, 180, 90, 1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].untidedBelow).toBe(true);
  };
  check();
  store.rebuildOverviews();
  check();
});

test("the writer reduces each sounding by its own tide after QC", async () => {
  const start = Temporal.Instant.from("2026-10-16T08:00:00Z");
  const store = createCellStore(createDB(":memory:"));
  const writer = createCellWriter(store, { flushIntervalMs: 100_000 });
  // The same 5 m sounder depth everywhere, on a tide rising 1 cm a sounding: QC sees a
  // flat sounder only where it's flat for real.
  const data: BathymetryData[] = Array.from({ length: 40 }, (_, i) => ({
    latitude: 36.98 + i * 0.0003,
    longitude: -76.2,
    depth: 5 + (i % 3) * 0.1,
    timestamp: start.add({ seconds: i * 10 }),
    tide: { level: 1 + i * 0.01, sigma: 0.3 },
  }));
  for (const d of data) writer.write(d, () => {});
  await new Promise<void>((resolve) => writer.end(() => resolve()));
  const cells = store.cells(-76.3, 36, -76.1, 37.1);
  expect(cells.length).toBeGreaterThan(20);
  for (const c of cells) {
    expect(c.t).toBe(0.3);
    // Below chart datum: the sounder's depth less a metre or more of tide.
    expect(c.m).toBeLessThan(4.2);
    expect(c.m).toBeGreaterThan(3.4);
  }
});

test("a pass with some soundings tided uses only those", async () => {
  const start = Temporal.Instant.from("2026-10-16T08:00:00Z");
  const store = createCellStore(createDB(":memory:"));
  const writer = createCellWriter(store, { flushIntervalMs: 100_000 });
  // Every other sounding missed its tide; the raw ones read 2 m deeper.
  const data: BathymetryData[] = Array.from({ length: 40 }, (_, i) => ({
    latitude: 36.98 + Math.floor(i / 2) * 0.0003,
    longitude: -76.2,
    depth: 6 + (i % 3) * 0.1,
    timestamp: start.add({ seconds: i * 5 }),
    ...(i % 2 ? {} : { tide: { level: 2, sigma: 0.3 } }),
  }));
  for (const d of data) writer.write(d, () => {});
  await new Promise<void>((resolve) => writer.end(() => resolve()));
  for (const c of store.cells(-76.3, 36, -76.1, 37.1)) {
    expect(c.t).toBe(0.3);
    expect(c.m).toBeLessThan(4.3);
  }
});

test("a backfill rebuilds the cells when signalk-tides starts or stops answering", async () => {
  const { createSqliteSource } = await import("../../src/sources/sqlite.js");
  const { addPendingBackfill, backfillCells, TIDE_CONFIG_KEY } =
    await import("../../src/tiles/backfill.js");
  const { app, config } = await import("../helper.js");
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  const start = Temporal.Instant.from("2026-10-16T08:00:00Z");
  await pipeline(
    Readable.from(
      Array.from({ length: 100 }, (_, i) => ({
        latitude: 36.98 + i * 0.0003,
        longitude: -76.2,
        depth: 5 + (i % 3) * 0.1,
        timestamp: start.add({ seconds: i * 10 }),
        heading: 0,
      })),
    ),
    source.createWriter!(),
  );
  const store = createCellStore(db);
  const fake = (answering: boolean) =>
    ({
      at: async () => (answering ? { level: 1, sigma: 0.3 } : undefined),
      ready: async () => answering,
    }) as never;
  const run = (tides: unknown) =>
    backfillCells({
      app,
      config,
      source,
      store,
      signal: new AbortController().signal,
      tides: tides as never,
    });
  const cells = () => store.cells(-76.3, 36.9, -76.1, 38);

  addPendingBackfill(store, start.add({ hours: 12 }), historySpan(config));
  await run(fake(false));
  expect(cells()[0].t).toBeUndefined();
  expect(store.getMeta(TIDE_CONFIG_KEY)).toBe("null");
  // The same again: nothing to rebuild, nothing pending.
  await run(fake(false));
  expect(cells()[0].passes).toBe(1);
  // Read-only access turned on: rebuilt tided, from the log.
  await run(fake(true));
  expect(cells()).toHaveLength(100);
  expect(cells().every((c) => c.t === 0.3 && c.passes === 1)).toBe(true);
  // signalk-tides removed: rebuilt untided.
  await run(undefined);
  expect(cells().every((c) => c.t === undefined)).toBe(true);
});

test("a day with holes in its levels goes untided", async () => {
  const near = station("noaa/1", 38.95, -76.45);
  const tides = await started(
    fakeApi([near, annapolis], { holes: ["noaa/1"] }).get,
  );
  expect(await tides.at(-76.45, 38.95, noon)).toBeNull();
});

test("a station the API has no details for is passed over for the next", async () => {
  const api = fakeApi([annapolis]);
  const listed = station("noaa/gone", 38.95, -76.45);
  const get = (path: string) =>
    path.startsWith("/stations?")
      ? (api.get(path) as Promise<Station[]>).then((l) => [
          {
            id: listed.id,
            latitude: listed.latitude,
            longitude: listed.longitude,
          },
          ...l,
        ])
      : api.get(path);
  const tides = await started(get);
  expect((await tides.at(-76.45, 38.95, noon))!.level).toBeCloseTo(1.2, 6);
});

test("a refused or failed timeline request is asked again, not counted as the day's", async () => {
  const api = fakeApi([annapolis]);
  let refuse = true;
  const tides = await started((path) =>
    refuse && path.includes("/timeline")
      ? Promise.reject(new ApiError("401", 401, true))
      : api.get(path),
  );
  expect(await tides.at(-76.48, 38.98, noon)).toBeUndefined();
  refuse = false;
  expect((await tides.at(-76.48, 38.98, noon))!.level).toBeCloseTo(1.2, 1);
});
