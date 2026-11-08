// The "My soundings" background runtime: a headless iframe the host loads while the
// plugin is enabled. The host draws the data overlay itself; this keeps it current. It
// polls the plugin for the tiles the boat's passes changed and asks the host to refetch
// them, draws the soundings not yet in a tile and the surface they make round the boat,
// and sets the user's depth unit.
//
// Freeboard redraws the whole layer on any refresh, however few tiles it names, so
// refreshes are batched: to one per 5 s where the view holds few tiles, and longer as it
// holds more, as the plugin works out from the view the host reports; to one per
// REFRESH_MS where the host reports none. Soundings stay drawn as provisional until the
// refresh that brings in their tiles has landed, and the preview, the surface their
// passes make, below the tiles, until it's in them, so the track has no gap at zoom 10
// and in, where tiles refresh as the boat goes. Further out they refresh every 5 minutes.
//
// It polls only while the overlay is drawn and the plotter's tab is showing.
import { connectExtension } from "signalk-plotterext-bus/extension";
import type {
  MapView,
  OverlayStateEvent,
} from "signalk-plotterext-bus/extension";
import { createBatch, type Live } from "./batch.js";

// The overlay and source ids in src/plotterext/manifest.ts and src/tiles/style.ts.
const overlayId = "depth";
const POLL_MS = 2000;
const REFRESH_MS = 30_000;
/** How long a poll may take before it's given up, and the next poll tries again. Host
 * calls give up after the bus's own default, also 10 s. */
const TIMEOUT_MS = 10_000;
const LIVE_URL = "/plotterext/crowd-depth/live";
const M_PER_FT = 0.3048;

const client = await connectExtension();

let drawn = true;
/** The host's view, for the plugin to batch refreshes by what it holds. */
let view: MapView | undefined;
let busy = false;
let timer: ReturnType<typeof setInterval> | undefined;
const batch = createBatch(REFRESH_MS);
/** The preview's revision the host holds, -1 for none; how many times it's been
 * forgotten, so a poll in flight doesn't record one the host may have dropped; and the
 * contour unit to ask for. */
let previewRev = -1;
let forgotten = 0;
let contourUnit = "m";

async function poll(): Promise<void> {
  if (busy) return;
  busy = true;
  // Not `AbortSignal.timeout`, which Safari before 16 lacks.
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const at = view ? `&view=${[view.zoom, ...view.bounds].join(",")}` : "";
    const unit = contourUnit;
    const asOf = forgotten;
    const ask = `&preview=${previewRev}&unit=${unit}`;
    const res = await fetch(`${LIVE_URL}?since=${batch.rev}${at}${ask}`, {
      credentials: "include",
      signal: abort.signal,
    });
    if (!res.ok) return;
    const live = (await res.json()) as Live & {
      preview?: { rev: number; features: unknown[] };
    };
    const { refresh, data, upsert, remove } = batch.next(live);
    if (refresh) {
      await client.call("overlay.refresh", {
        overlayId,
        source: "cells",
        ...refresh,
      });
    }
    if (data) {
      await client.call("overlay.setData", {
        overlayId,
        source: "provisional",
        data: { type: "FeatureCollection", features: data },
      });
    } else if (upsert || remove) {
      await client.call("overlay.setData", {
        overlayId,
        source: "provisional",
        ...(upsert ? { upsert } : {}),
        ...(remove ? { remove } : {}),
      });
    }
    batch.taken();
    // Apart from the rest, so a host that can't take it, as one holding a style from
    // before the preview, doesn't redo the refresh each poll: asked for again instead.
    if (live.preview) {
      await client
        .call("overlay.setData", {
          overlayId,
          source: "preview",
          data: { type: "FeatureCollection", features: live.preview.features },
        })
        .then(() => {
          // Not if the unit changed meanwhile: its contours are the other unit's.
          if (live.preview && unit === contourUnit && asOf === forgotten) {
            previewRev = live.preview.rev;
          }
        })
        .catch(() => {});
    }
  } catch {
    // The server is restarting, a call timed out, or the overlay isn't drawn; the next
    // poll tries again.
    batch.failed();
  } finally {
    clearTimeout(timeout);
    busy = false;
  }
}

/** Poll while the overlay is drawn and the tab is showing, and at once when both
 * become so; else not at all. */
function schedule(): void {
  const active = drawn && document.visibilityState === "visible";
  if (active && !timer) {
    // The host may have dropped the soundings, and the preview, while the overlay was
    // off.
    batch.resend();
    previewRev = -1;
    forgotten++;
    timer = setInterval(() => void poll(), POLL_MS);
    void poll();
  } else if (!active && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

async function loadUnits(): Promise<void> {
  try {
    const res = (await client.call("units.get")) as {
      units?: { depth?: string };
    };
    const feet = res?.units?.depth === "foot";
    const unit = feet ? "ft" : "m";
    // The preview held has the other unit's contours: sent again.
    if (unit !== contourUnit) previewRev = -1;
    contourUnit = unit;
    await client.call("overlay.setState", {
      overlayId,
      values: {
        depthLabel: feet ? "depth_ft" : "depth_m",
        metresPerUnit: feet ? M_PER_FT : 1,
        contourUnit: feet ? "ft" : "m",
      },
    });
  } catch {
    // No units capability: the labels stay in metres.
  }
}

await client.subscribe(["overlay.state"], (_name, payload) => {
  const state = payload as OverlayStateEvent;
  if (state.overlayId !== overlayId) return;
  drawn = state.visible && !state.suspended;
  schedule();
});
document.addEventListener("visibilitychange", schedule);

if (client.hasCapability("map")) {
  // Optional: without it, refreshes keep the runtime's own batch.
  await client
    .subscribe(["map.view"], (_name, payload) => {
      view = payload as MapView;
    })
    .catch(() => {});
  // Not awaited, nor over a view the host has sent since.
  client.map
    .getView()
    .then((v) => (view ??= v))
    .catch(() => {});
}

await loadUnits();
schedule();
