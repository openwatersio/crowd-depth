import type { DatabaseSync } from "node:sqlite";
import type { Observation, PreviewView } from "./history-preview.js";
import { spatialPreviewQuery } from "./preview-spatial.js";
type Row = Observation & { py: number; px: number };
type Box = [west: number, south: number, east: number, north: number];
const order = (a: Row, b: Row) => b.time - a.time || a.py - b.py || a.px - b.px;

/** Pending evidence across the viewport, independent of previous polls. This is a
 * bounded, geographically stratified sample, not a global timestamp sort. */
export function createPreviewQuery(db: DatabaseSync) {
  const query = spatialPreviewQuery(db);
  const latest = db.prepare("SELECT MAX(time) AS time FROM preview_times");
  return {
    read(view: PreviewView, since: number): Row[] {
      const [, west, south, east, north] = view;
      const boxes: Box[] =
        west > east
          ? [
              [west, south, 180, north],
              [-180, south, east, north],
            ]
          : [[west, south, east, north]];
      const recent = Math.max(
        since,
        Number(latest.get()?.time ?? since) - 86400_000,
      );
      const sample = (areas: Box[], limit: number) => {
        const read = (from: number, until: number, count: number) =>
          areas
            .flatMap(
              ([w, s, e, n]) => query(w, s, e, n, from, count, until) as Row[],
            )
            .sort(order)
            .slice(0, count);
        const rows = read(recent, Number.MAX_SAFE_INTEGER, limit);
        if (rows.length < limit && recent > since)
          rows.push(...read(since, recent, limit - rows.length));
        return rows;
      };
      const first = sample(boxes, 1200);
      if (first.length < 1200) return first;
      // A depth-first R*Tree sample alone can fill the limit from one track segment.
      // Reserve a share for each part of the view, then reuse the first query to fill
      // unused capacity. Inclusive index margins can overlap at subdivision edges.
      const found = new Map<string, Row>();
      const columns = 4 / boxes.length;
      for (const [w, s, e, n] of boxes)
        for (let y = 0; y < 4; y++)
          for (let x = 0; x < columns; x++) {
            const box: Box = [
              w + ((e - w) * x) / columns,
              s + ((n - s) * y) / 4,
              w + ((e - w) * (x + 1)) / columns,
              s + ((n - s) * (y + 1)) / 4,
            ];
            for (const p of sample([box], 75)) found.set(`${p.py}/${p.px}`, p);
          }
      for (const p of first) {
        if (found.size >= 1200) break;
        found.set(`${p.py}/${p.px}`, p);
      }
      return [...found.values()].sort(order);
    },
  };
}
