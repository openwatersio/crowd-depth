// Gate server-side rendering measurements; browser paint still needs a plotter check.
// Run bench-viewport with >=5 rounds and a Signal K health URL, then check its JSONL.
import { readFileSync } from "node:fs";
const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: check-viewport-benchmark.mjs results.jsonl");
const rows = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const views = rows.filter((r) => Number.isInteger(r.round));
const healthRows = rows.filter((r) => Array.isArray(r.health));
const failures = [];
const require = (ok, reason) => {
  if (!ok) failures.push(reason);
};
require(healthRows.length ===
  1, "Expected one complete benchmark run and health summary");
require(views.length >= 15, "Need at least five rounds at zooms 13, 14 and 15");
for (let round = 0; round < 5; round++)
  for (const z of [13, 14, 15])
    require(views.some(
      (v) => v.round === round && v.z === z,
    ), `Missing round ${round}, zoom ${z}`);
for (const v of views) {
  require(v.results?.length === 9 &&
    v.results.every(
      (t) => Number.isFinite(t.ms) && t.ms >= 0,
    ), `Incomplete viewport: round ${v.round}, zoom ${v.z}`);
  require(Number.isFinite(v.firstVisibleMs) &&
    v.firstVisibleMs <= 500 &&
    v.results?.some(
      (t) => t.bytes > 0,
    ), `First populated tile exceeded 500 ms or absent: round ${v.round}, zoom ${v.z}`);
  // Round zero starts the workers; it is still subject to the first-content target.
  if (v.round > 0)
    require(Number.isFinite(v.coldMs) &&
      v.coldMs <=
        1000, `Cold viewport exceeded 1 s: round ${v.round}, zoom ${v.z}`);
}
const health = healthRows.flatMap((r) => r.health);
require(health.length >=
  30, "Need at least 30 concurrent Signal K HTTP samples");
require(health.every(
  (h) => h.status === 200 && !h.error && Number.isFinite(h.ms) && h.ms >= 0,
), "Signal K HTTP failed or timed out");
const times = health.map((h) => h.ms).sort((a, b) => a - b);
const p95 = times[Math.ceil(times.length * 0.95) - 1];
require(Number.isFinite(p95) &&
  p95 < 250, "Signal K HTTP p95 must be below 250 ms");
console.log(
  JSON.stringify(
    {
      pass: failures.length === 0,
      views: views.length,
      httpSamples: health.length,
      httpP95Ms: p95,
      failures,
    },
    null,
    2,
  ),
);
process.exitCode = failures.length ? 1 : 0;
