// Read-only bounded viewport benchmark. Build first, then:
// node scripts/bench-history-preview.mjs database west south east north
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { createPreviewQuery } from "../dist/tiles/preview-query.js";

const [file, ...args] = process.argv.slice(2);
const bounds = args.slice(0, 4).map(Number);
const [west, south, east, north] = bounds;
if (
  !file ||
  bounds.length !== 4 ||
  !bounds.every(Number.isFinite) ||
  Math.abs(west) > 180 ||
  Math.abs(east) > 180 ||
  south < -85 ||
  north > 85 ||
  south > north
)
  throw new Error(
    "usage: bench-history-preview.mjs database west south east north",
  );
const db = new DatabaseSync(file, { readOnly: true });
try {
  const query = createPreviewQuery(db);
  const times = [],
    counts = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    const rows = query.read([14, ...bounds], 0);
    times.push(performance.now() - start);
    counts.push(rows.length);
    await sleep(25);
  }
  const sorted = times.toSorted((a, b) => a - b);
  console.log(
    JSON.stringify({
      firstMs: times[0],
      medianMs: sorted[15],
      p95Ms: sorted[28],
      maxMs: sorted[29],
      counts,
    }),
  );
} finally {
  db.close();
}
