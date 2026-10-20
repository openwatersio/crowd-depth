// What the runtime asks the host to draw, poll by poll: tile refreshes batched to one per
// interval, since Freeboard redraws the whole layer on each, and the soundings to draw
// as provisional, kept until the refresh that brings in their tiles has landed.

export type Tile = [number, number, number];
export interface Feature {
  id: string | number;
}
export interface Live {
  rev: number;
  all?: boolean;
  tiles: Tile[];
  /** Ids of soundings just written to cells. */
  stored?: (string | number)[];
  provisional: { features: Feature[] };
}

export function createBatch(refreshMs: number, now = () => Date.now()) {
  let rev = -1;
  const pending = new Map<string, Tile>();
  let pendingAll = false;
  let lastRefresh = now();
  /** Soundings written since the last refresh, still drawn until their tiles are. */
  const written = new Map<string | number, Feature>();
  /** Those a refresh has covered, dropped on the next poll, once its tiles have loaded. */
  let covered = new Set<string | number>();
  let shown = new Map<string | number, Feature>();
  let shownKey = "";
  /** The last refresh handed out, put back if the host doesn't take it. */
  let lastAsked: { tiles: Tile[]; all: boolean } | undefined;

  return {
    get rev() {
      return rev;
    },
    /** Fold in one poll's answer: the refresh to ask for, if it's time, and the
     * provisional features, if they changed. */
    next(live: Live): { refresh?: { tiles?: Tile[] }; data?: Feature[] } {
      // The first answer only says where the feed is: the host has just fetched tiles.
      if (rev >= 0) {
        if (live.all) pendingAll = true;
        for (const t of live.tiles) pending.set(t.join("/"), t);
      }
      rev = live.rev;

      for (const id of covered) written.delete(id);
      const current = new Map(live.provisional.features.map((f) => [f.id, f]));
      // A sounding the plugin wrote to a cell stays until its tile is refreshed; any
      // other that leaves the list, rejected by QC or past the list's end, goes.
      const stored = new Set(live.stored ?? []);
      for (const [id, f] of shown) {
        if (!current.has(id) && !covered.has(id) && stored.has(id)) {
          written.set(id, f);
        }
      }
      covered = new Set();

      lastAsked = undefined;
      let refresh: { tiles?: Tile[] } | undefined;
      if ((pendingAll || pending.size) && now() - lastRefresh >= refreshMs) {
        refresh = pendingAll ? {} : { tiles: [...pending.values()] };
        lastAsked = { tiles: [...pending.values()], all: pendingAll };
        pending.clear();
        pendingAll = false;
        lastRefresh = now();
        covered = new Set(written.keys());
      }

      shown = new Map([...written, ...current]);
      const key = [...shown.keys()].join(",");
      if (key === shownKey) return { refresh };
      shownKey = key;
      return { refresh, data: [...shown.values()] };
    },
    /** The host took the last answer. */
    taken() {
      lastAsked = undefined;
    },
    /** The host didn't take the last answer: ask for its refresh and data again. */
    failed() {
      if (lastAsked) {
        for (const t of lastAsked.tiles) pending.set(t.join("/"), t);
        if (lastAsked.all) pendingAll = true;
        lastRefresh = -Infinity;
        covered = new Set();
      }
      lastAsked = undefined;
      shownKey = "";
    },
  };
}
