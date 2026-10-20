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
      // A sounding the plugin no longer lists is in a stored cell, not yet in a tile.
      for (const [id, f] of shown) {
        if (!current.has(id) && !covered.has(id)) written.set(id, f);
      }
      covered = new Set();

      let refresh: { tiles?: Tile[] } | undefined;
      if ((pendingAll || pending.size) && now() - lastRefresh >= refreshMs) {
        refresh = pendingAll ? {} : { tiles: [...pending.values()] };
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
  };
}
