// The "My soundings" background runtime: a headless iframe the host loads while the
// plugin is enabled. The host draws the data overlay itself; this keeps it current. It
// polls the plugin for the tiles the boat's passes changed and asks the host to refetch
// them, draws the soundings not yet in a tile, and sets the user's depth unit.
//
// Freeboard redraws the whole layer on any refresh, however few tiles it names, so
// refreshes are batched to one per REFRESH_MS. Soundings stay drawn as provisional until
// the refresh that brings in their tiles has landed, so the track has no gap at zoom 10
// and in, where tiles refresh as the boat goes. Further out they refresh every 5 minutes.
//
// It polls only while the overlay is drawn and the plotter's tab is showing.
import { connectExtension } from "signalk-plotterext-bus/extension";
import type { OverlayStateEvent } from "signalk-plotterext-bus/extension";
import { createBatch, type Live } from "./batch.js";

// The overlay and source ids in src/plotterext/manifest.ts and src/tiles/style.ts.
const overlayId = "depth";
const POLL_MS = 2000;
const REFRESH_MS = 30_000;
/** How long a poll or a host call may take before it's given up, and the next poll
 * tries again. */
const TIMEOUT_MS = 10_000;
const LIVE_URL = "/plotterext/crowd-depth/live";
const M_PER_FT = 0.3048;

const client = await connectExtension({ callTimeoutMs: TIMEOUT_MS });

let drawn = true;
let busy = false;
let timer: ReturnType<typeof setInterval> | undefined;
const batch = createBatch(REFRESH_MS);

async function poll(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const res = await fetch(`${LIVE_URL}?since=${batch.rev}`, {
      credentials: "include",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return;
    const { refresh, data, upsert, remove } = batch.next(
      (await res.json()) as Live,
    );
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
  } catch {
    // The server is restarting, a call timed out, or the overlay isn't drawn; the next
    // poll tries again.
    batch.failed();
  } finally {
    busy = false;
  }
}

/** Poll while the overlay is drawn and the tab is showing, and at once when both
 * become so; else not at all. */
function schedule(): void {
  const active = drawn && document.visibilityState === "visible";
  if (active && !timer) {
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

await loadUnits();
schedule();
