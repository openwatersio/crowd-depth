// The "My soundings" background runtime: a headless iframe the host loads while the
// plugin is enabled. The host draws the data overlay itself; this keeps it current. It
// polls the plugin for the tiles the boat's passes changed and asks the host to refetch
// just those, replaces the provisional soundings, and sets the user's depth unit.
import { connectExtension } from "signalk-plotterext-bus/extension";
import type { OverlayStateEvent } from "signalk-plotterext-bus/extension";

// The overlay and source ids in src/plotterext/manifest.ts and src/tiles/style.ts.
const overlayId = "depth";
const POLL_MS = 2000;
const LIVE_URL = "/plotterext/crowd-depth/live";
const M_PER_FT = 0.3048;

const client = await connectExtension();

let rev = -1;
let visible = true;
let busy = false;

async function poll(): Promise<void> {
  if (!visible || busy) return;
  busy = true;
  try {
    const res = await fetch(`${LIVE_URL}?since=${rev}`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const live = (await res.json()) as {
      rev: number;
      all?: boolean;
      tiles: [number, number, number][];
      provisional: unknown;
    };
    // `all` on the first poll too: the host may have fetched tiles before a backfill
    // finished, and refetching the view once costs little.
    if (live.all) {
      await client.call("overlay.refresh", { overlayId, source: "cells" });
    } else if (live.tiles.length) {
      await client.call("overlay.refresh", {
        overlayId,
        source: "cells",
        tiles: live.tiles,
      });
    }
    rev = live.rev;
    await client.call("overlay.setData", {
      overlayId,
      source: "provisional",
      data: live.provisional,
    });
  } catch {
    // The server is restarting or the overlay isn't drawn; the next poll tries again.
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
