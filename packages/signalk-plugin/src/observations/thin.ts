import { Temporal } from "@js-temporal/polyfill";
import type { Observation } from "./store.js";

export interface ThinningOptions {
  horizontalToleranceM: number;
  depthToleranceM: number;
  maxGapSeconds: number;
  stationarySpeedMps: number;
}

/** Derived-only simplification of a bounded, single-acquisition batch.
 * Original observations remain in the archive. Moving/unknown-speed observations
 * are retained, as are source/quality transitions and the two ends of every gap. */
export function thinStationary(
  points: readonly Observation[],
  options: ThinningOptions,
): number[] {
  const {
    horizontalToleranceM: xy,
    depthToleranceM: dz,
    maxGapSeconds: gap,
    stationarySpeedMps: speed,
  } = options;
  if (
    ![xy, dz, gap, speed].every(Number.isFinite) ||
    xy <= 0 ||
    dz <= 0 ||
    gap < 60 ||
    gap > 360 ||
    speed < 0 ||
    points.length > 16384
  )
    throw new Error("Invalid stationary thinning options or batch size");
  if (!points.length) return [];
  const times = points.map(
    (p) => Temporal.Instant.from(p.timestamp).epochNanoseconds,
  );
  const seconds = (a: number, b: number) => Number(times[b] - times[a]) / 1e9;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (
      ![p.longitude, p.latitude, p.depth].every(Number.isFinite) ||
      Math.abs(p.longitude) > 180 ||
      Math.abs(p.latitude) > 90
    )
      throw new Error("Invalid or unordered observations");
  }
  // Source failover or clock corrections can reorder arrivals; preserve the batch intact.
  if (times.some((time, i) => i > 0 && time < times[i - 1]))
    return points.map((_, i) => i);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stationary = (p: Observation) =>
    p.speedOverGround !== undefined &&
    Number.isFinite(p.speedOverGround) &&
    p.speedOverGround >= 0 &&
    p.speedOverGround <= speed;
  const signature = (p: Observation) =>
    JSON.stringify([
      p.depthSource,
      p.positionSource,
      p.gnss?.methodQuality,
      p.gnss?.integrity,
      p.gnss?.type,
    ]);
  let anchor = 0;
  for (let i = 1; i < points.length; i++) {
    if (
      !stationary(points[i - 1]) ||
      !stationary(points[i]) ||
      signature(points[i - 1]) !== signature(points[i]) ||
      seconds(i - 1, i) > gap ||
      times[i] === times[i - 1]
    ) {
      keep[i - 1] = keep[i] = 1;
      anchor = i;
    } else if (seconds(anchor, i) > gap) {
      keep[i - 1] = 1;
      anchor = i - 1;
    }
  }
  const anchors = Array.from(keep.keys()).filter((i) => keep[i]);
  const stack: [number, number][] = [];
  for (let i = 1; i < anchors.length; i++)
    stack.push([anchors[i - 1], anchors[i]]);
  const longitudeDelta = (from: number, to: number) =>
    ((to - from + 540) % 360) - 180;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;
    const first = points[a],
      last = points[b];
    const scaleX = 111320 * Math.cos((first.latitude * Math.PI) / 180),
      scaleY = 111320;
    const bx = longitudeDelta(first.longitude, last.longitude) * scaleX;
    const by = (last.latitude - first.latitude) * scaleY;
    const length2 = bx * bx + by * by;
    let worst = 1,
      split = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const x = longitudeDelta(first.longitude, p.longitude) * scaleX;
      const y = (p.latitude - first.latitude) * scaleY;
      const t = length2
        ? Math.max(0, Math.min(1, (x * bx + y * by) / length2))
        : 0;
      const horizontal = Math.hypot(x - t * bx, y - t * by) / xy;
      // Depth is interpolated at the observation's original time, not its distance along the track.
      const expected =
        first.depth +
        ((last.depth - first.depth) * seconds(a, i)) / seconds(a, b);
      const vertical = Math.abs(p.depth - expected) / dz;
      const error = Math.max(horizontal, vertical);
      if (error > worst) {
        worst = error;
        split = i;
      }
    }
    if (split >= 0) {
      keep[split] = 1;
      stack.push([a, split], [split, b]);
    }
  }
  return Array.from(keep.keys()).filter((i) => keep[i]);
}
