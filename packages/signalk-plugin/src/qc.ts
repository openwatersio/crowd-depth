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
  steep_factor: number;
  steep_abs_m: number;
  steep_slope: number;
  steep_floor_m: number;
  noise_window: number;
  noise_rel: number;
  noise_abs_m: number;
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
  flag: "reject" | "review" | "unconfirmed" | "noisy",
  reason:
    | "sentinel"
    | "time"
    | "very_shallow"
    | "jump"
    | "steep"
    | "flatline"
    | "track_noise"
    | "spike",
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

/** Median of each sounding's window of k either side, as numpy's rolling_median. */
function rollingMedian(values: number[], k: number): number[] {
  return values.map((_, j) => {
    const w = values.slice(Math.max(0, j - k), j + k + 1).sort((a, b) => a - b);
    const lo = w[(w.length - 1) >> 1];
    const hi = w[w.length >> 1];
    return f32(lo + f32(hi - lo) * 0.5);
  });
}

/** Positions in `track` deeper than the steep bound from the last one before them that wasn't. */
function steepPass(track: Sounding[], qc: QCDefinitions): boolean[] {
  const out = track.map(() => false);
  let anchor = 0;
  for (let j = 1; j < track.length; j++) {
    const a = track[anchor];
    const bound =
      qc.steep_factor * Math.max(a.depth, qc.steep_floor_m) +
      qc.steep_abs_m +
      qc.steep_slope * distance(a, track[j]);
    if (track[j].depth > bound) out[j] = true;
    else anchor = j;
  }
  return out;
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

    // Steep: deeper than steep_factor times the last depth before it that wasn't, plus
    // steep_abs_m and steep_slope metres a metre, from both directions.
    const along = kept.map((i) => pts[i]);
    const forward = steepPass(along, qc);
    const backward = steepPass([...along].reverse(), qc).reverse();
    // A stretch at the transit's start or end is judged from its one side.
    const leading = backward.findIndex((b) => !b);
    const trailing = forward.findLastIndex((f) => !f);
    const level = kept.filter((i, j) => {
      const steep =
        (forward[j] && backward[j]) ||
        (backward[j] && (leading === -1 || j < leading)) ||
        (forward[j] && j > trailing);
      if (steep) flags.push([i, "reject", "steep"]);
      return !steep;
    });

    // Stuck sounders: one depth held over flat_m of path and flat_min_soundings soundings,
    // and, shallower than hazard_m, across flat_span_m.
    const clean: number[] = [];
    for (let j = 0; j < level.length;) {
      let end = j + 1;
      let length = 0;
      while (
        end < level.length &&
        pts[level[end]].depth === pts[level[j]].depth
      ) {
        length += distance(pts[level[end - 1]], pts[level[end]]);
        end++;
      }
      const run = level.slice(j, end);
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

    // Noise: the track's median zig-zag beyond noise_rel of its median depth and
    // noise_abs_m. A sounding's zig-zag is the least of its distances from the middle of
    // its neighbors and from each of them.
    const depths = clean.map((i) => pts[i].depth);
    const rough = depths.map((d, j) => {
      if (j === 0 || j === depths.length - 1) return 0;
      const [before, after] = [depths[j - 1], depths[j + 1]];
      const mid = f32(f32(before + after) / 2);
      return Math.min(
        Math.abs(f32(d - mid)),
        Math.abs(f32(d - before)),
        Math.abs(f32(d - after)),
      );
    });
    const roughness = rollingMedian(rough, qc.noise_window);
    const typical = rollingMedian(depths, qc.noise_window);
    const noisy = clean.map(
      (i, j) =>
        roughness[j] > f32(f32(qc.noise_rel) * typical[j]) &&
        roughness[j] > f32(qc.noise_abs_m),
    );
    // Spikes: off the median of spike_window soundings either side by more than
    // spike_abs_m + spike_rel of it. Deeper is rejected, shoaler kept as unconfirmed: it
    // may be a rock. On a noisy track a deeper one is noise, and a shoaler one is kept as
    // unconfirmed track_noise, which neither confirms nor is confirmed.
    const judged = clean.length >= qc.spike_min_soundings;
    const medians = rollingMedian(depths, qc.spike_window);
    clean.forEach((i, j) => {
      const med = medians[j];
      const d = pts[i].depth;
      const spike =
        judged &&
        Math.abs(f32(d - med)) >
          f32(f32(qc.spike_abs_m) + f32(f32(qc.spike_rel) * med));
      if (spike && !(d > med))
        flags.push([i, "unconfirmed", noisy[j] ? "track_noise" : "spike"]);
      else if (noisy[j]) flags.push([i, "noisy", "track_noise"]);
      else if (spike) flags.push([i, "reject", "spike"]);
    });
  }
  return flags;
}
