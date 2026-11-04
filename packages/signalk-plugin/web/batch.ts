// What the runtime asks the host to draw, poll by poll: tile refreshes batched to one per
// interval, since Freeboard redraws the whole layer on each, and the soundings to draw
// as provisional, kept until the refresh that brings in their tiles has landed. Once the
// host holds the soundings, only the ones that came, changed or went are sent.

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
/** One poll's answer: the refresh to ask for, and the provisional soundings to set,
 * either all of them as `data` or what changed as `upsert` and `remove`. */
export interface Next {
  refresh?: { tiles?: Tile[] };
  data?: Feature[];
  upsert?: Feature[];
  remove?: (string | number)[];
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
  /** The soundings the host holds, each as JSON so a changed one is sent again; unknown
   * at first, and after an answer the host may not have taken. */
  let held: Map<string | number, string> | undefined;
  /** What the host holds once it takes the last answer. */
  let offered: Map<string | number, string> | undefined;
  /** The last refresh handed out, put back if the host doesn't take it. */
  let lastAsked: { tiles: Tile[]; all: boolean } | undefined;

  return {
    get rev() {
      return rev;
    },
    /** Fold in one poll's answer: the refresh to ask for, if it's time, and the
     * provisional features, if they changed. */
    next(live: Live): Next {
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
      const json = new Map(
        [...shown].map(([id, f]) => [id, JSON.stringify(f)]),
      );
      offered = json;
      if (!held) return { refresh, data: [...shown.values()] };
      const upsert = [...shown.values()].filter(
        (f) => held!.get(f.id) !== json.get(f.id),
      );
      const remove = [...held.keys()].filter((id) => !shown.has(id));
      if (!upsert.length && !remove.length) {
        offered = undefined;
        return { refresh };
      }
      return {
        refresh,
        ...(upsert.length ? { upsert } : {}),
        ...(remove.length ? { remove } : {}),
      };
    },
    /** The host took the last answer. */
    taken() {
      lastAsked = undefined;
      if (offered) held = offered;
      offered = undefined;
    },
    /** The host didn't take the last answer: ask for its refresh again, and send every
     * sounding, since the host may have taken some of it. */
    failed() {
      if (lastAsked) {
        for (const t of lastAsked.tiles) pending.set(t.join("/"), t);
        if (lastAsked.all) pendingAll = true;
        lastRefresh = -Infinity;
        covered = new Set();
      }
      lastAsked = undefined;
      if (offered) held = undefined;
      offered = undefined;
    },
  };
}
