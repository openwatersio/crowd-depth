// Synthetic index-only scaling fixture: no sample bodies, renderer, or provider.
import { DatabaseSync } from "node:sqlite";
import { openObservationStore } from "../dist/observations/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
const [parent, ...sizes] = process.argv.slice(2);
if (!parent)
  throw Error(
    "usage: bench-import-index.mjs <fixture-parent> [window-counts...]",
  );
const counts = sizes.length ? sizes.map(Number) : [1000, 10000, 100000];
if (counts.some((n) => !Number.isInteger(n) || n < 128 || n > 1000000))
  throw Error("window counts must be 128..1000000");
const dir = mkdtempSync(join(parent, "import-index-bench-"));
const file = join(dir, "observations.sqlite");
const store = openObservationStore(file),
  db = new DatabaseSync(file);
try {
  db.exec(
    "INSERT INTO observation_import_contexts VALUES(1,'history'),(2,'other')",
  );
  for (const count of counts) {
    db.exec(`BEGIN; DELETE FROM observation_import_spatial; DELETE FROM observation_import_windows;
     WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${count})
     INSERT INTO observation_import_windows SELECT x,CASE WHEN x%2=0 THEN 'history' ELSE 'other' END,x*3600000,(x+1)*3600000 FROM n;
     INSERT INTO observation_import_spatial SELECT id,
       CASE WHEN id%2=0 THEN -800000000 ELSE 120000000 END,
       CASE WHEN id%2=0 THEN -800000000 ELSE 120000000 END,260000000,260000000,
       CASE WHEN id%2=0 THEN 1 ELSE 2 END,CASE WHEN id%2=0 THEN 1 ELSE 2 END,
       CAST(start/86400000 AS INTEGER),CAST((end-1)/86400000 AS INTEGER),id,id FROM observation_import_windows;
     COMMIT;`);
    const results = [];
    const end = (count + 2) * 3600000;
    for (const [name, bounds, from, to, expected, before] of [
      ["populated", [-81, 25, -79, 27], 0, end, 64],
      ["middle-page", [-81, 25, -79, 27], 0, end, 64, Math.floor(count / 2)],
      ["empty", [-81, 40, -79, 42], 0, end, 0],
      ["other-context-only", [11, 25, 13, 27], 0, end, 0],
      ["outside-time", [-81, 25, -79, 27], end, end + 3600000, 0],
    ]) {
      const ms = [];
      for (let i = 0; i < 30; i++) {
        const begin = performance.now();
        const rows = store.importedPageInView(
          "history",
          from,
          to,
          bounds,
          before,
        ).windows;
        ms.push(performance.now() - begin);
        if (expected) assert(rows.length > 0 && rows.length <= expected);
        else assert.equal(rows.length, 0);
      }
      ms.sort((a, b) => a - b);
      results.push({
        name,
        p50Ms: ms[15],
        p95Ms: ms[28],
        maxMs: ms[29],
        samples: ms.length,
      });
    }
    console.log(
      JSON.stringify({
        kind: "synthetic-import-index",
        windows: count,
        results,
      }),
    );
  }
} finally {
  db.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
