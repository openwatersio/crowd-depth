import { Temporal } from "@js-temporal/polyfill";
import type { Observation, AcquisitionStage } from "./store.js";

/** Reconcile one version without transferring evidence across ambiguous matches. */
export function mergeObservationGroups(
  merged: Map<bigint, Observation[]>,
  incoming: Map<bigint, Observation[]>,
  stage: AcquisitionStage,
) {
  // A revised aggregate replaces its whole timestamp group, including duplicates.
  for (const [time, points] of incoming) {
    const prior = merged.get(time) ?? [];
    // An incomplete, unattributed refresh cannot safely replace calibrated
    // observations or borrow their metadata. Keep that whole old group;
    // new timestamps still land, and the incoming version stays archived.
    if (
      stage === "partial" &&
      [...prior, ...points].some((p) => !p.depthSource || !p.positionSource) &&
      prior.some(
        (p) =>
          p.headingTrue !== undefined ||
          p.courseOverGroundTrue !== undefined ||
          p.speedOverGround !== undefined ||
          p.gnss !== undefined,
      )
    )
      continue;
    const evidenceKey = (p: Observation) =>
      p.depthSource && p.positionSource
        ? JSON.stringify([
            p.depthSource,
            p.positionSource,
            p.longitude,
            p.latitude,
            p.positionTimestamp
              ? Temporal.Instant.from(p.positionTimestamp).toString()
              : null,
          ])
        : undefined;
    const evidence = new Map<string, Observation | undefined>();
    for (const previous of merged.get(time) ?? []) {
      const key = evidenceKey(previous);
      if (key) evidence.set(key, evidence.has(key) ? undefined : previous);
    }
    const seen = new Set<string>(),
      ambiguous = new Set<string>();
    for (const point of points) {
      const key = evidenceKey(point);
      if (key) {
        if (seen.has(key)) ambiguous.add(key);
        seen.add(key);
      }
    }
    merged.set(
      time,
      points.map((point) => {
        const key = evidenceKey(point);
        const previous =
          key && !ambiguous.has(key) ? evidence.get(key) : undefined;
        if (!previous) return point;
        // Missing optional fields are not withdrawals. Only match unambiguous actual provenance.
        return {
          ...point,
          headingTrue: point.headingTrue ?? previous.headingTrue,
          courseOverGroundTrue:
            point.courseOverGroundTrue ?? previous.courseOverGroundTrue,
          speedOverGround: point.speedOverGround ?? previous.speedOverGround,
          gnss:
            previous.gnss || point.gnss
              ? { ...previous.gnss, ...point.gnss }
              : undefined,
        };
      }),
    );
  }
}
