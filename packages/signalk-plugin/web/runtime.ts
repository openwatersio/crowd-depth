// The "My soundings" background runtime: a headless iframe the host loads while the
// plugin is enabled. The host draws the data overlay itself; this keeps it current. It
// polls the plugin for the tiles the boat's passes changed and asks the host to refetch
// them, draws the soundings not yet in a tile, and sets the user's depth unit.
//
// Freeboard redraws the whole layer on any refresh, however few tiles it names, so
// refreshes are batched to one per REFRESH_MS. Soundings stay drawn as provisional until
// the refresh that brings in their tiles has landed, so the track has no gap at zoom 10
// and in, where tiles refresh as the boat goes. Further out they refresh every 5 minutes.
import { connectExtension } from "signalk-plotterext-bus/extension";
import type { OverlayStateEvent } from "signalk-plotterext-bus/extension";
import { createBatch, type Live } from "./batch.js";

// The overlay and source ids in src/plotterext/manifest.ts and src/tiles/style.ts.
const overlayId = "depth";
const POLL_MS = 2000;
const REFRESH_MS = 30_000;
const LIVE_URL = "/plotterext/crowd-depth/live";
const M_PER_FT = 0.3048;

const client = await connectExtension();

let visible = true;
let busy = false;
const batch = createBatch(REFRESH_MS);

async function poll(): Promise<void> {
  if (!visible || busy) return;
  busy = true;
  try {
    const res = await fetch(`${LIVE_URL}?since=${batch.rev}`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const { refresh, data } = batch.next((await res.json()) as Live);
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
    }
    batch.taken();
  } catch {
    // The server is restarting or the overlay isn't drawn; the next poll tries again.
    batch.failed();
  } finally {
    busy = false;
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
  visible = state.visible && !state.suspended;
  if (visible) void poll();
});

await loadUnits();
await poll();
setInterval(() => void poll(), POLL_MS);
