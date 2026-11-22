/** Mergeable time-weighted moments. Time is milliseconds; half-life is days. */
export interface Moments {
  time: number;
  weight: number;
  weight2: number;
  mean: number;
  m2: number;
  tide: number;
  passes: number;
  first: number;
  last: number;
}
export const DEFAULT_HALF_LIFE_DAYS = 365;
export function halfLifeDays(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= 36500
    ? value
    : DEFAULT_HALF_LIFE_DAYS;
}
/** Weighted parallel-variance merge; no subtraction of nearly equal squared depths. */
export function mergeMoments(
  a: Moments | undefined,
  b: Moments,
  days: number,
): Moments {
  if (!a) return { ...b };
  const time = Math.max(a.time, b.time);
  const scale = (t: number) => 2 ** ((t - time) / (days * 86400000));
  const sa = scale(a.time),
    sb = scale(b.time);
  const wa = a.weight * sa,
    wb = b.weight * sb,
    weight = wa + wb;
  const delta = b.mean - a.mean;
  return {
    time,
    weight,
    weight2: a.weight2 * sa * sa + b.weight2 * sb * sb,
    mean: a.mean + delta * (wb / weight),
    m2: a.m2 * sa + b.m2 * sb + delta * delta * (wa / weight) * wb,
    tide: a.tide + (b.tide - a.tide) * (wb / weight),
    passes: a.passes + b.passes,
    first: Math.min(a.first, b.first),
    last: Math.max(a.last, b.last),
  };
}
/** Between-hour sample dispersion, retaining within-hour spread and a one-hour prior. */
export function momentSigma(m: Moments, prior = 0.375): number {
  const denominator = m.weight - m.weight2 / m.weight;
  return denominator > m.weight * 1e-12
    ? Math.sqrt(Math.max(0, m.m2 / denominator))
    : Math.sqrt(Math.max(0, m.m2 / m.weight) + prior * prior);
}
