// The "My soundings" background runtime: a headless iframe the host loads while the
// plugin is enabled. It owns the soundings, asks its render Worker for a frame
// on each `overlay.request`, and answers with `overlay.frame`.
//
// Data comes from the plugin's gridded bathymetry tiles over same-origin REST,
// since the runtime is served by the same server. The own vessel's live
// position and depth arrive over the bus (`signalk.subscribe`) and extend the
// tiles in place, corrected the same way the plugin corrects what it records.
//
// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.

import { connectExtension } from "signalk-plotterext-bus/extension";
import type {
  OverlayRequestEvent,
  OverlayStateEvent,
} from "signalk-plotterext-bus/extension";
import type { DepthSample } from "./shared/live-depth.js";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type LayerSettings,
} from "./shared/settings.js";
import type { RenderRequest, RenderWorkerOut } from "./shared/protocol.js";
import {
  createMemoryTileStore,
  createTileAccumulator,
  cellsToSamples,
  correctToTransducer,
  decodeTileSamples,
  tileRangeForBbox,
  zoomForCellSize,
  DISPLAY_MAX_ZOOM,
  MIN_COG_SPEED,
  cellSize,
  MIN_ZOOM,
  type TileMeta,
  type TransducerOffset,
} from "../src/tiles/core/index.js";

const PLUGIN_ID = "crowd-depth";
const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;
const BATHY_BASE = `${ASSET_BASE}/bathymetry`;

/** Settle time before a moved view or a changed window is fetched. */
const DEBOUNCE_MS = 400;
/** Most tile fetches a single view may need before the layer draws nothing. */
const MAX_TILE_FETCHES = 24;
/** How often the view's tiles are refetched while visible, which picks up the
 * live soundings the plugin has written. */
const REFETCH_MS = 60000;
/** How long the client keeps its own live soundings. The plugin writes base
 * tiles every 10 s but rebuilds the coarser levels only every 5 minutes, so
 * anything younger may be missing from the served tiles. */
const LIVE_KEEP_MS = 10 * 60000;
/** Oldest a position, heading or course may be for a live depth to use it,
 * matching the plugin's live stream. */
const LIVE_TTL_MS = 2000;
/** How long live soundings are batched before folding into the client store.
 * Kept short so the surface fills in under the bow rather than a couple of
 * seconds behind it. */
const LIVE_FLUSH_MS = 300;
/** Depth path when the plugin advertises none. */
const DEFAULT_DEPTH_PATH = "environment.depth.belowTransducer";

const client = await connectExtension();
const worker = new Worker(new URL("./render-worker.js", import.meta.url), {
  type: "module",
});

let settings: LayerSettings = { ...DEFAULT_SETTINGS };
let transducer: TransducerOffset | null = null;
let depthPath = DEFAULT_DEPTH_PATH;
/** Added to each live depth, as the plugin adds it to what it records. */
let depthOffset = 0;
/** Whether the plugin's corrections are known. Until they are, live soundings
 * are left out rather than drawn uncorrected. */
let metaLoaded = false;

let samples: DepthSample[] = [];
/** The server-derived soundings, without the client's live
 * extension — the base `compose()` folds the live cells onto. */
let baseSamples: DepthSample[] = [];
let lastReq: RenderRequest | null = null;
let busy = false;
let dirty = false;
/** The request currently being rendered. Its frame carries this request's own
 * id and extent, even if a newer one arrives mid-render, so the host refuses a
 * stale frame as `superseded` rather than reading it as a size mismatch. */
let rendering: RenderRequest | null = null;
/** Whether the frame being rendered is a live (data-driven) one, sent without a
 * request id and paced by the host's `liveInterval`. */
let renderingLive = false;
/** The host's least interval between two live frames, in ms. */
let liveInterval = 200;
/** When the last live frame was sent, to pace the next. */
let lastLiveAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

// Client-side mirror of the tile store, extended from the live stream.
let lastZoom = 0;
let clientStore = createMemoryTileStore();
let clientAccumulator = createTileAccumulator(clientStore);
let clientStoreSince = Date.now();
/** The client's live soundings, oldest first, kept for {@link LIVE_KEEP_MS}. */
let liveSoundings: { sounding: DepthSample; at: number }[] = [];
let liveDirty = false;
let liveFlushTimer: ReturnType<typeof setInterval> | undefined;

// ******** settings ********

async function loadSettings(): Promise<void> {
  try {
    const values = await client.state.get();
    settings = mergeSettings(values as Record<string, unknown>);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  worker.postMessage({ type: "settings", settings });
  if (settings.enabled) {
    startLive();
  } else {
    stopLive();
  }
  schedule();
}

// ******** data ********

async function loadMeta(): Promise<void> {
  try {
    const res = await fetch(`${BATHY_BASE}/meta`, {
      credentials: "same-origin",
    });
    if (!res.ok) return;
    const meta = (await res.json()) as TileMeta;
    // While the plugin restarts it serves no settings; keep the last ones
    // rather than drawing live soundings uncorrected.
    if (!meta.depthPath) return;
    const nextTransducer = meta.transducer ?? null;
    const nextOffset = meta.depthOffset ?? 0;
    if (
      JSON.stringify(nextTransducer) !== JSON.stringify(transducer) ||
      nextOffset !== depthOffset ||
      meta.depthPath !== depthPath
    ) {
      // The plugin rebuilt its tiles with the new correction; the client's
      // soundings were placed with the old one.
      liveSoundings = [];
      resetClientStore();
    }
    transducer = nextTransducer;
    depthOffset = nextOffset;
    metaLoaded = true;
    if (meta.depthPath !== depthPath) {
      depthPath = meta.depthPath;
      if (liveUnsub) {
        stopLive();
        startLive();
      }
    }
  } catch {
    // No plugin meta: live soundings are left uncorrected.
  }
}

/** Shift a sounding from the GNSS antenna to the transducer, as the plugin
 * does: by heading, else by course over ground while making way. Undefined
 * when the offset can't be applied, so the sounding is dropped, not misplaced. */
function correct(
  lon: number,
  lat: number,
): { lon: number; lat: number } | undefined {
  if (!transducer) return { lon, lat };
  const heading = fresh(liveHeading);
  const course = fresh(liveCourse);
  const speed = fresh(liveSpeed);
  const bearing =
    heading ??
    (speed !== undefined && speed >= MIN_COG_SPEED ? course : undefined);
  return correctToTransducer({ lon, lat }, bearing, transducer);
}

/** Ask the host for the user's preferred depth unit, for the labels. */
async function loadUnits(): Promise<void> {
  try {
    const res = (await client.call("units.get")) as {
      units?: { depth?: string };
    };
    if (res?.units?.depth) {
      worker.postMessage({ type: "units", depth: res.units.depth });
    }
  } catch {
    // No units capability: the labels stay in metres.
  }
}

/** Bumped per fetch, so a slow fetch for an old view can't replace a newer one. */
let fetchSeq = 0;

async function fetchTiles(req: RenderRequest): Promise<void> {
  const seq = ++fetchSeq;
  const cellMetres = Math.max(req.resolution, 0.01);
  let zoom = zoomForCellSize(cellMetres, MIN_ZOOM, DISPLAY_MAX_ZOOM);
  while (zoom > MIN_ZOOM) {
    const { xs, ys } = tileRangeForBbox(req.bounds, zoom);
    if (xs.length * ys.length <= MAX_TILE_FETCHES) break;
    zoom--;
  }
  const { xs, ys } = tileRangeForBbox(req.bounds, zoom);
  if (xs.length * ys.length > MAX_TILE_FETCHES) {
    // Zoomed out past what the layer draws.
    lastZoom = 0;
    baseSamples = [];
    compose();
    return;
  }
  const fetchedAt = Date.now();
  const out: DepthSample[] = [];
  let failed = false;
  await Promise.all(
    xs.flatMap((x) =>
      ys.map(async (y) => {
        try {
          const res = await fetch(`${BATHY_BASE}/tiles/${zoom}/${x}/${y}`, {
            credentials: "same-origin",
          });
          if (res.status === 404) return; // no soundings there
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          out.push(...decodeTileSamples(zoom, x, y, bytes));
        } catch {
          failed = true;
        }
      }),
    ),
  );
  // Keep what's drawn when a newer fetch started or a tile couldn't be read,
  // rather than blanking shoals the server still holds.
  if (seq !== fetchSeq || failed) return;
  lastZoom = zoom;
  baseSamples = out;
  // Drop the client's soundings the served tiles hold by now, so its copy
  // stays a few minutes long.
  if (fetchedAt - clientStoreSince > LIVE_KEEP_MS) resetClientStore();
  compose();
}

/** Rebuild the client's store from its recent soundings only. */
function resetClientStore(): void {
  const cutoff = Date.now() - LIVE_KEEP_MS;
  liveSoundings = liveSoundings.filter((s) => s.at >= cutoff);
  clientStore = createMemoryTileStore();
  clientAccumulator = createTileAccumulator(clientStore);
  for (const { sounding } of liveSoundings) clientAccumulator.add(sounding);
  clientAccumulator.flush();
  clientStoreSince = liveSoundings[0]?.at ?? Date.now();
}

/** The client store's live soundings for the current view, at the level the
 * view is drawn at. */
function clientSamples(): DepthSample[] {
  const bbox = lastReq?.bounds;
  if (!bbox || !lastZoom) {
    return [];
  }
  const { xs, ys } = tileRangeForBbox(bbox, lastZoom);
  if (xs.length * ys.length > MAX_TILE_FETCHES) {
    return [];
  }
  const out: DepthSample[] = [];
  for (const x of xs) {
    for (const y of ys) {
      const cells = clientStore.read(lastZoom, x, y);
      if (cells && cells.size) {
        out.push(...cellsToSamples(lastZoom, x, y, cells));
      }
    }
  }
  return out;
}

/** The drawn soundings: the server data plus the live extension, composed
 * locally so a flush never needs a network round trip. */
function compose(): void {
  samples = aroundView([...baseSamples, ...clientSamples()]);
  publish();
}

/** Wrap longitudes to within half a world of the view's centre, so a view
 * across the antimeridian gets one compact field rather than one spanning the
 * globe from -180° to +180°. */
function aroundView(list: DepthSample[]): DepthSample[] {
  const bounds = lastReq?.bounds;
  if (!bounds) return list;
  const centre = (bounds[0] + bounds[2]) / 2;
  return list.map((s) => {
    const lon = s.lon - Math.round((s.lon - centre) / 360) * 360;
    return lon === s.lon ? s : { ...s, lon };
  });
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
}

async function refresh(): Promise<void> {
  if (!settings.enabled) return;
  await loadMeta();
  if (lastReq) await fetchTiles(lastReq);
}

function publish(): void {
  worker.postMessage({
    type: "samples",
    samples,
    cellMetres: lastZoom ? cellSize(lastZoom) : 0,
  });
  dirty = true;
  // A live frame for the last request, so the layer updates without a new one.
  if (lastReq) draw(true);
}

// ******** live extension ********

let liveUnsub: (() => Promise<void>) | undefined;

function startLive(): void {
  if (!settings.enabled || liveUnsub) return;
  void client.signalk
    .subscribe(
      [
        "navigation.position",
        depthPath,
        "navigation.headingTrue",
        "navigation.courseOverGroundTrue",
        "navigation.speedOverGround",
      ],
      (ev) => {
        const value = typeof ev.value === "number" ? ev.value : undefined;
        const now = Date.now();
        if (ev.path === "navigation.position" && Array.isArray(ev.value)) {
          livePosition = { value: ev.value as [number, number], at: now };
        } else if (ev.path === "navigation.headingTrue") {
          liveHeading = value === undefined ? undefined : { value, at: now };
        } else if (ev.path === "navigation.courseOverGroundTrue") {
          liveCourse = value === undefined ? undefined : { value, at: now };
        } else if (ev.path === "navigation.speedOverGround") {
          liveSpeed = value === undefined ? undefined : { value, at: now };
        } else if (ev.path === depthPath && value) {
          // One sounding per depth reading, at the latest position, as the
          // plugin records them; a position update alone adds nothing, and a
          // depth of zero is skipped, as the plugin skips it.
          sampleLive(value);
        }
      },
    )
    .then((un) => {
      liveUnsub = un;
    })
    .catch(() => {});
  clearInterval(liveFlushTimer);
  liveFlushTimer = setInterval(flushLive, LIVE_FLUSH_MS);
}

function stopLive(): void {
  clearInterval(liveFlushTimer);
  liveFlushTimer = undefined;
  void liveUnsub?.();
  liveUnsub = undefined;
}

type Timed<T> = { value: T; at: number };

let livePosition: Timed<[number, number]> | undefined;
let liveHeading: Timed<number> | undefined;
let liveCourse: Timed<number> | undefined;
let liveSpeed: Timed<number> | undefined;

/** A live value if it was received recently enough to use. */
function fresh<T>(timed: Timed<T> | undefined): T | undefined {
  return timed && Date.now() - timed.at <= LIVE_TTL_MS
    ? timed.value
    : undefined;
}

function sampleLive(depth: number): void {
  if (!metaLoaded) return;
  const at = fresh(livePosition);
  if (!at) return;
  const position = correct(at[0], at[1]);
  if (!position) return;
  const sounding = { ...position, depth: depth + depthOffset };
  clientAccumulator.add(sounding);
  liveSoundings.push({ sounding, at: Date.now() });
  liveDirty = true;
}

function flushLive(): void {
  if (!liveDirty) return;
  liveDirty = false;
  clientAccumulator.flush();
  // Fold the new soundings in locally — no tile re-fetch, so the live path is
  // just the store write plus the render.
  compose();
}

// ******** frame cycle ********

function draw(live = false): void {
  if (busy || !lastReq || !settings.enabled) return;
  if (live && Date.now() - lastLiveAt < liveInterval) return;
  busy = true;
  rendering = lastReq;
  renderingLive = live;
  dirty = false;
  worker.postMessage({ type: "render", req: rendering });
}

worker.onmessage = (e: MessageEvent<RenderWorkerOut>) => {
  const msg = e.data;
  const req = rendering;
  const live = renderingLive;
  busy = false;
  rendering = null;
  if (msg.type !== "frame" || !req) {
    return;
  }
  if (live) lastLiveAt = Date.now();
  // The host owns the image once it is transferred, and closes a refused one
  // itself, so there is nothing to release here. A live frame carries no
  // request id, so the host paces it against `liveInterval`.
  void client.overlays
    .frame({
      overlayId: req.overlayId,
      requestId: live ? undefined : req.requestId,
      extent: req.extent,
      image: msg.image,
    })
    .catch(() => {});
  // A newer request arrived, or the data changed, while this frame rendered.
  if (dirty || lastReq !== req) draw(live);
};

// ******** bus wiring ********

await loadMeta();

await client.subscribe(["overlay.request"], (_name, payload) => {
  const req = payload as OverlayRequestEvent;
  const moved =
    !lastReq ||
    lastReq.zoom !== req.zoom ||
    lastReq.bounds.some((v, i) => v !== req.bounds[i]);
  lastReq = req;
  if (moved) schedule();
  if (typeof req.liveInterval === "number" && req.liveInterval > 0) {
    liveInterval = req.liveInterval;
  }
  draw();
});

await client.subscribe(["overlay.state"], (_name, payload) => {
  const state = payload as OverlayStateEvent;
  if (!state.visible || state.suspended) {
    worker.postMessage({ type: "release" });
    stopLive();
  } else {
    startLive();
    schedule();
  }
});

await client.subscribe(["state.changed"], () => void loadSettings());

await loadSettings();
await loadUnits();
setInterval(() => {
  if (settings.enabled && liveUnsub) schedule();
}, REFETCH_MS);
