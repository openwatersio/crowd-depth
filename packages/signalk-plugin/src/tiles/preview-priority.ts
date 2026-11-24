import type { DatabaseSync } from "node:sqlite";
import { cellAt, cellCenter } from "./geometry.js";
import type { PreviewView } from "./history-preview.js";

/** Migration-only key seeks: start at the view's centre and visit populated rows
 * outwards. Each call examines at most 32 rows and returns at most 500 cells. */
export function previewPriority(db: DatabaseSync, view: PreviewView) {
  const [, west, south, east, north] = view;
  const centre = cellAt(0, (south + north) / 2).py;
  const lo = cellAt(0, south).py,
    hi = cellAt(0, north).py;
  const up = db.prepare(
    "SELECT py FROM preview_cells WHERE py>=? AND py<=? ORDER BY py LIMIT 1",
  );
  const down = db.prepare(
    "SELECT py FROM preview_cells WHERE py<=? AND py>=? ORDER BY py DESC LIMIT 1",
  );
  const page = db.prepare(
    "SELECT py,px FROM preview_cells WHERE py=? AND px>=? AND px<=? AND px>? ORDER BY px LIMIT ?",
  );
  let above = centre,
    below = centre - 1;
  let row:
    | { py: number; bounds: [number, number][]; part: number; after: number }
    | undefined;
  let done = false;
  return {
    get done() {
      return done;
    },
    next() {
      const found: { py: number; px: number }[] = [];
      let visited = row ? 1 : 0;
      while (found.length < 500 && visited < 32 && !done) {
        if (!row) {
          const a = (up.get(above, hi) as { py: number } | undefined)?.py;
          const b = (down.get(below, lo) as { py: number } | undefined)?.py;
          if (a === undefined && b === undefined) {
            done = true;
            break;
          }
          const py =
            b === undefined || (a !== undefined && a - centre <= centre - b)
              ? a!
              : b;
          if (py === a) above = py + 1;
          else below = py - 1;
          const lat = cellCenter(py, 0).lat;
          const boxes =
            west > east
              ? [
                  [west, 180],
                  [-180, east],
                ]
              : [[west, east]];
          row = {
            py,
            bounds: boxes.map(([w, e]) => [
              cellAt(w, lat).px,
              cellAt(e, lat).px,
            ]),
            part: 0,
            after: -Infinity,
          };
          visited++;
        }
        const [px0, px1] = row.bounds[row.part];
        const room = 500 - found.length;
        const rows = page.all(row.py, px0, px1, row.after, room) as {
          py: number;
          px: number;
        }[];
        found.push(...rows);
        if (rows.length === room) row.after = rows.at(-1)!.px;
        else if (++row.part < row.bounds.length) row.after = -Infinity;
        else row = undefined;
      }
      return found;
    },
  };
}
