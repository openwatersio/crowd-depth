// Track QC: the grid's checks (packages/grid/src/grid/qc.py) as plain loops, run on the
// grid's definitions and checked against its test vectors (packages/grid/tests/qc_vectors.json).
//
// Depths are float32 in the grid's store, so depth arithmetic rounds through float32
// (Math.fround) as numpy's does, and flags match the grid's on every shared vector. A
// sounding within an ulp of a threshold may still differ, since cos and sums can round
// differently in numpy.

/** The `qc` section of packages/grid/src/grid/definitions.json. */
export interface QCDefinitions {
  earliest: string;
  arrival_slack_s: number;
  max_depth_m: number;
  shallow_m: number;
  transit_gap_s: number;
  transit_span_s: number;
  max_speed_kn: number;
  spike_window: number;
  spike_abs_m: number;
  spike_rel: number;
  spike_min_soundings: number;
  flat_m: number;
  flat_min_soundings: number;
  flat_span_m: number;
  hazard_m: number;
}

export interface Sounding {
  /** Microseconds since the epoch. */
  time: number;
  lon: number;
  lat: number;
  /** Metres below the transducer or reference. */
  depth: number;
}

export type Flag = [
  index: number,
  flag: "reject" | "review" | "unconfirmed",
  reason: "sentinel" | "time" | "very_shallow" | "jump" | "flatline" | "spike",
];

const US = 1_000_000;
const f32 = Math.fround;
const RADIANS = Math.PI / 180;

/** Metres from a to b, equirectangular at a's latitude; longitude wraps at the antimeridian. */
function distance(a: Sounding, b: Sounding): number {
  const dx =
    (((b.lon - a.lon + 540) % 360) - 180) * Math.cos(a.lat * RADIANS) * 111320;
  const dy = (b.lat - a.lat) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Knots from a to b; pairs less than a second apart count as one second. */
function speed(a: Sounding, b: Sounding): number {
  return (
    (distance(a, b) / Math.max(Math.abs(b.time / US - a.time / US), 1)) *
    1.943844
  );
}

/**
 * QC one file's soundings, given in the order they were written. `arrival` is when the
 * file arrived, in microseconds since the epoch. Returns flags by index into `soundings`.
 */
export function trackQC(
  soundings: Sounding[],
  arrival: number,
  qc: QCDefinitions,
): Flag[] {
  const flags: Flag[] = [];
  const pts = soundings.map((s) => ({ ...s, depth: f32(s.depth) }));
  const earliest = Date.parse(`${qc.earliest}T00:00:00Z`) * 1000;
  const track: number[] = [];
  pts.forEach((p, i) => {
    if (p.depth > 0 && p.depth < qc.shallow_m)
      flags.push([i, "review", "very_shallow"]);
    if (p.depth <= 0 || p.depth > qc.max_depth_m)
      flags.push([i, "reject", "sentinel"]);
    else if (p.time < earliest || p.time > arrival + qc.arrival_slack_s * US)
      flags.push([i, "reject", "time"]);
    else track.push(i);
  });
  // Along the track: by time, then the order soundings were written in (a stable sort).
  track.sort((a, b) => pts[a].time - pts[b].time);

  // A transit ends at a gap of more than transit_gap_s, and every transit_span_s.
  const transits: number[][] = [];
  let start = 0;
  let key = "";
  track.forEach((i, j) => {
    const t = pts[i].time;
    if (j === 0 || t - pts[track[j - 1]].time > qc.transit_gap_s * US)
      start = t;
    const next = `${start}:${Math.floor((t - start) / (qc.transit_span_s * US))}`;
    if (next !== key) transits.push([]);
    key = next;
    transits[transits.length - 1].push(i);
  });

  for (const transit of transits) {
    // Jumps: both legs faster than max_speed_kn and than twice the speed straight past.
    const kept = transit.filter((i, j) => {
      if (j === 0 || j === transit.length - 1) return true;
      const [a, b, c] = [pts[transit[j - 1]], pts[i], pts[transit[j + 1]]];
      const jumped =
        Math.min(speed(a, b), speed(b, c)) >
        Math.max(qc.max_speed_kn, 2 * speed(a, c));
      if (jumped) flags.push([i, "reject", "jump"]);
      return !jumped;
    });

    // Stuck sounders: one depth held over flat_m of path and flat_min_soundings soundings,
    // and, shallower than hazard_m, across flat_span_m.
    const clean: number[] = [];
    for (let j = 0; j < kept.length;) {
      let end = j + 1;
      let length = 0;
      while (end < kept.length && pts[kept[end]].depth === pts[kept[j]].depth) {
        length += distance(pts[kept[end - 1]], pts[kept[end]]);
        end++;
      }
      const run = kept.slice(j, end);
      const d = pts[run[0]].depth;
      if (length >= qc.flat_m && run.length >= qc.flat_min_soundings) {
        // Across the run's bounding box, at its mean latitude.
        let [west, east, south, north, sum] = [
          Infinity,
          -Infinity,
          Infinity,
          -Infinity,
          0,
        ];
        for (const i of run) {
          west = Math.min(west, pts[i].lon);
          east = Math.max(east, pts[i].lon);
          south = Math.min(south, pts[i].lat);
          north = Math.max(north, pts[i].lat);
          sum += pts[i].lat;
        }
        const span = east - west;
        const dx =
          Math.min(span, 360 - span) *
          Math.cos((sum / run.length) * RADIANS) *
          111320;
        const dy = (north - south) * 110540;
        if (
          d >= qc.hazard_m ||
          Math.sqrt(dx * dx + dy * dy) >= qc.flat_span_m
        ) {
          const flag = d < qc.hazard_m ? "unconfirmed" : "reject";
          for (const i of run) flags.push([i, flag, "flatline"]);
          j = end;
          continue;
        }
      }
      for (const i of run) clean.push(i);
      j = end;
    }

    // Spikes: off the median of spike_window soundings either side by more than
    // spike_abs_m + spike_rel of it. Deeper is rejected, shoaler kept as unconfirmed.
    if (clean.length < qc.spike_min_soundings) continue;
    const k = qc.spike_window;
    clean.forEach((i, j) => {
      const w = clean
        .slice(Math.max(0, j - k), j + k + 1)
        .map((c) => pts[c].depth)
        .sort((a, b) => a - b);
      const lo = w[(w.length - 1) >> 1];
      const hi = w[w.length >> 1];
      const med = f32(lo + f32(hi - lo) * 0.5);
      const d = pts[i].depth;
      if (
        Math.abs(f32(d - med)) >
        f32(f32(qc.spike_abs_m) + f32(f32(qc.spike_rel) * med))
      )
        flags.push([i, d > med ? "reject" : "unconfirmed", "spike"]);
    });
  }
  return flags;
}
