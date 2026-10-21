// Time the live writer for a boat at anchor: a 10 Hz sounder over 100 minutes, the boat
// swinging within 30 m, with the depth wobbling, holding to the centimetre, and holding
// with one position fix 1 km off. QC runs on its thread, as live. Reports the slowest
// single write, which holds up the server, the CPU of both threads, and the cost of the
// provisional soundings each chart poll reads.
//
//   npm run build && node scripts/bench-anchor.mjs [minutes]
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../dist/storage.js";
import { createCellStore, createCellWriter } from "../dist/tiles/index.js";
import { createQCThread } from "../dist/tiles/qc-thread.js";

const minutes = Number(process.argv[2] ?? 100);
const n = minutes * 60 * 10;

for (const [name, depth, glitch] of [
  ["wobbling ±0.1 m", (i) => 5 + Math.round(Math.sin(i * 0.37) * 10) / 100],
  ["steady 5.0 m", () => 5],
  ["steady, one fix off", () => 5, 6000],
]) {
  const qc = createQCThread();
  const store = createCellStore(createDB(":memory:"));
  // Each sounding waits for QC's findings before the next, as at 10 Hz, where QC
  // answers long before the next one, and the soundings end now, as live.
  let runs = 0;
  let pending;
  // It sails 100 minutes in about one, so the 10 s flush would let written passes pile
  // up: it flushes every 5 ms instead, which overstates the cost of writes.
  const writer = createCellWriter(store, {
    flushIntervalMs: 5,
    qc: (soundings, arrival) => {
      runs++;
      return (pending = qc.run(soundings, arrival));
    },
  });
  const t0 = Date.now() - n * 100;
  const writes = [];
  let worstProvisional = 0;
  let most = 0;
  const cpu0 = process.cpuUsage();
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    writer.write({
      latitude: 36.98 + Math.sin(i / 3000) * 0.0001 + (i === glitch ? 0.01 : 0),
      longitude: -76.2 + Math.cos(i / 3000) * 0.0001,
      depth: depth(i),
      timestamp: Temporal.Instant.fromEpochMilliseconds(t0 + i * 100),
    });
    writes.push(performance.now() - a);
    await pending;
    await new Promise((r) => setImmediate(r));
    if (i % 20 === 0) {
      const b = performance.now();
      const p = writer.provisional();
      worstProvisional = Math.max(worstProvisional, performance.now() - b);
      most = Math.max(most, p.length);
    }
  }
  const cpu = process.cpuUsage(cpu0);
  writes.sort((x, y) => x - y);
  const q = (p) => writes[Math.floor(p * (writes.length - 1))].toFixed(2);
  console.log(
    `${name}: ${n} soundings, CPU ${((cpu.user + cpu.system) / 1000 / (minutes * 60)).toFixed(1)} ms/s of sailing; ` +
      `write p99 ${q(0.99)} ms, max ${q(1)} ms; ` +
      `provisional up to ${most}, slowest ${worstProvisional.toFixed(1)} ms; ${runs} QC runs`,
  );
  writer.destroy();
  qc.close();
}
