// Time the live writer for a boat at anchor: a 10 Hz sounder over 100 minutes, the boat
// swinging within 30 m, once with the depth wobbling and once holding to the centimetre.
// Reports the slowest single write, which holds up the server, and the cost of the
// provisional soundings each chart poll reads.
//
//   npm run build && node scripts/bench-anchor.mjs [minutes]
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../dist/storage.js";
import { createCellStore, createCellWriter } from "../dist/tiles/index.js";

const minutes = Number(process.argv[2] ?? 100);
const n = minutes * 60 * 10;

for (const [name, depth] of [
  ["wobbling ±0.1 m", (i) => 5 + Math.round(Math.sin(i * 0.37) * 10) / 100],
  ["steady 5.0 m", () => 5],
]) {
  const store = createCellStore(createDB(":memory:"));
  // The writer flushes every 10 s of sailing: the loop below gives its timer a turn
  // every 100 soundings.
  const writer = createCellWriter(store, { flushIntervalMs: 5 });
  const t0 = Temporal.Instant.from("2026-10-16T08:00:00Z").epochMilliseconds;
  const writes = [];
  let worstProvisional = 0;
  let most = 0;
  const cpu0 = process.cpuUsage();
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    writer.write({
      latitude: 36.98 + Math.sin(i / 3000) * 0.0001,
      longitude: -76.2 + Math.cos(i / 3000) * 0.0001,
      depth: depth(i),
      timestamp: Temporal.Instant.fromEpochMilliseconds(t0 + i * 100),
    });
    writes.push(performance.now() - a);
    if (i % 100 === 99) await new Promise((r) => setTimeout(r, 6));
    if (i % 20 === 0) {
      const b = performance.now();
      const p = writer.provisional();
      worstProvisional = Math.max(worstProvisional, performance.now() - b);
      most = Math.max(most, p.length);
    }
  }
  const cpu = process.cpuUsage(cpu0);
  // Less the waits for the flush timer, which aren't the writer's.
  writes.sort((x, y) => x - y);
  const q = (p) => writes[Math.floor(p * (writes.length - 1))].toFixed(2);
  console.log(
    `${name}: ${n} soundings, CPU ${((cpu.user + cpu.system) / 1000 / (minutes * 60)).toFixed(1)} ms/s of sailing; ` +
      `write p99 ${q(0.99)} ms, max ${q(1)} ms; ` +
      `provisional up to ${most}, slowest ${worstProvisional.toFixed(1)} ms`,
  );
  writer.destroy();
}
