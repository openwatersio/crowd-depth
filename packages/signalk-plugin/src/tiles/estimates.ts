import type { DatabaseSync } from "node:sqlite";
import type { Cell, Pass } from "./cells.js";
import {
  halfLifeDays,
  mergeMoments,
  momentSigma,
  type Moments,
} from "./decay.js";
const HOUR = 3600_000;
const FANOUT = 256;
export const estimateHour = (micros: number) =>
  Math.floor(micros / (HOUR * 1000));

/** One capped contribution per UTC hour/cell/reference, then a shallow merge tree.
 * Updating an old hour reads at most 256 children at each intermediate level,
 * not every pass ever collected at an anchorage. Original pass records are kept.
 */
export function createEstimates(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS cell_moments(
    py INTEGER NOT NULL, px INTEGER NOT NULL, level INTEGER NOT NULL, bucket INTEGER NOT NULL,
    reference INTEGER NOT NULL, time REAL NOT NULL, weight REAL NOT NULL, weight2 REAL NOT NULL,
    mean REAL NOT NULL, m2 REAL NOT NULL, tide REAL NOT NULL, passes INTEGER NOT NULL,
    first INTEGER NOT NULL, last INTEGER NOT NULL,
    PRIMARY KEY(py,px,level,reference,bucket)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS cell_moment_config(
    py INTEGER NOT NULL, px INTEGER NOT NULL, days REAL NOT NULL,
    PRIMARY KEY(py,px)
  ) WITHOUT ROWID`);
  const columns = "time,weight,weight2,mean,m2,tide,passes,first,last";
  const children = db.prepare(`SELECT bucket,${columns} FROM cell_moments
    WHERE py=? AND px=? AND level=? AND reference=? AND bucket>=? AND bucket<? ORDER BY bucket`);
  const roots = db.prepare(`SELECT bucket,${columns} FROM cell_moments
    WHERE py=? AND px=? AND level=? AND reference=? ORDER BY bucket LIMIT 257`);
  const leaf = db.prepare(
    `SELECT ${columns} FROM cell_moments WHERE py=? AND px=? AND level=0 AND reference=? AND bucket=?`,
  );
  const published = db.prepare("SELECT 1 FROM cells WHERE py=? AND px=?");
  const put = db.prepare(
    "INSERT OR REPLACE INTO cell_moments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const drop = db.prepare(
    "DELETE FROM cell_moments WHERE py=? AND px=? AND level=? AND reference=? AND bucket=?",
  );
  const passes = db.prepare(
    "SELECT time,day,depth,tide FROM cell_passes WHERE py=? AND px=? AND time>=? AND time<? ORDER BY time,job,ordinal",
  );
  const save = (
    py: number,
    px: number,
    level: number,
    bucket: number,
    reference: number,
    m: Moments | undefined,
  ) => {
    if (m)
      put.run(
        py,
        px,
        level,
        bucket,
        reference,
        m.time,
        m.weight,
        m.weight2,
        m.mean,
        m.m2,
        m.tide,
        m.passes,
        m.first,
        m.last,
      );
    else drop.run(py, px, level, reference, bucket);
  };
  const merge = (rows: Iterable<unknown>, days: number) => {
    let result: Moments | undefined;
    for (const row of rows) result = mergeMoments(result, row as Moments, days);
    return result;
  };
  return {
    clear: () =>
      db.exec("DELETE FROM cell_moments; DELETE FROM cell_moment_config"),
    /** Fold pending passes through the same hourly summaries without writing.
     * Only touched ancestors are read; even years at anchor do not replay the log.
     */
    preview(py: number, px: number, pending: Pass[]): Cell | undefined {
      const days = halfLifeDays(
        Number(
          db
            .prepare("SELECT value FROM tile_meta WHERE key='config_weight'")
            .get()?.value ?? 365,
        ),
      );
      const storedDays = db
        .prepare("SELECT days FROM cell_moment_config WHERE py=? AND px=?")
        .get(py, px)?.days;
      // Reweighting owns changes to existing ancestors. Until it catches up, retain
      // the published cell instead of mixing summaries built with different decay.
      if (storedDays !== undefined && storedDays !== days) return;
      // Pre-ledger cells have no summaries to merge. Never replace their evidence
      // with a pending-only estimate while history is rebuilding the summaries.
      if (storedDays === undefined && published.get(py, px)) return;
      const top = Number(
        db
          .prepare(
            "SELECT MAX(level) AS level FROM cell_moments WHERE py=? AND px=?",
          )
          .get(py, px)?.level ?? 0,
      );
      const results: (Moments | undefined)[] = [];
      for (const ref of [0, 1]) {
        let updates = new Map<number, Moments>();
        for (const p of pending) {
          if (Number(p.tide !== undefined) !== ref) continue;
          const hour = estimateHour(p.time!);
          let m = updates.get(hour);
          if (!m) {
            const old = leaf.get(py, px, ref, hour) as unknown as
              Moments | undefined;
            // Hour summaries have unit weight. Restore their equal-weight passes
            // before adding this pass, then cap the combined hour again below.
            if (old)
              m = {
                ...old,
                weight: old.passes,
                weight2: old.passes,
                m2: old.m2 * old.passes,
              };
          }
          updates.set(
            hour,
            mergeMoments(
              m,
              {
                time: hour * HOUR,
                weight: 1,
                weight2: 1,
                mean: p.depth,
                m2: 0,
                tide: p.tide ?? 0,
                passes: 1,
                first: p.day,
                last: p.day,
              },
              days,
            ),
          );
        }
        for (const m of updates.values()) {
          m.m2 /= m.weight;
          m.weight = m.weight2 = 1;
        }
        for (let level = 0; level < top; level++) {
          const parents = new Map<number, Moments>();
          for (const parent of new Set(
            [...updates.keys()].map((b) => Math.floor(b / FANOUT)),
          )) {
            const values = new Map<number, Moments>(
              [
                ...children.iterate(
                  py,
                  px,
                  level,
                  ref,
                  parent * FANOUT,
                  (parent + 1) * FANOUT,
                ),
              ].map((r) => [Number(r.bucket), r as unknown as Moments]),
            );
            for (const [bucket, m] of updates)
              if (Math.floor(bucket / FANOUT) === parent) values.set(bucket, m);
            parents.set(
              parent,
              merge(
                [...values].sort((a, b) => a[0] - b[0]).map(([, m]) => m),
                days,
              )!,
            );
          }
          updates = parents;
        }
        const values = new Map<number, Moments>(
          roots
            .all(py, px, top, ref)
            .map((r) => [Number(r.bucket), r as unknown as Moments]),
        );
        for (const [bucket, m] of updates) values.set(bucket, m);
        results[ref] = merge(
          [...values].sort((a, b) => a[0] - b[0]).map(([, m]) => m),
          days,
        );
      }
      const m = results[1] ?? results[0];
      return (
        m && {
          py,
          px,
          m: m.mean,
          d: momentSigma(m) / 1.25,
          ...(results[1] ? { t: m.tide } : {}),
          passes: m.passes,
          first: m.first,
          last: m.last,
        }
      );
    },
    rebuild(py: number, px: number, hours: Iterable<number>): Cell | undefined {
      const config = db
        .prepare("SELECT value FROM tile_meta WHERE key='config_weight'")
        .get()?.value;
      const days = halfLifeDays(
        config === undefined ? undefined : Number(config),
      );
      const previous = db
        .prepare("SELECT days FROM cell_moment_config WHERE py=? AND px=?")
        .get(py, px)?.days;
      if (previous !== days) {
        // Hour summaries are independent of the half-life. Only ancestors need rebuilding.
        db.prepare(
          "DELETE FROM cell_moments WHERE py=? AND px=? AND level>0",
        ).run(py, px);
        db.prepare(
          "INSERT OR REPLACE INTO cell_moment_config VALUES(?,?,?)",
        ).run(py, px, days);
      }
      let touched = new Set(hours);
      for (const hour of touched) {
        const byReference: [Moments | undefined, Moments | undefined] = [
          undefined,
          undefined,
        ];
        for (const row of passes.iterate(
          py,
          px,
          hour * HOUR * 1000,
          (hour + 1) * HOUR * 1000,
        )) {
          const ref = row.tide === null ? 0 : 1;
          byReference[ref] = mergeMoments(
            byReference[ref],
            {
              time: hour * HOUR,
              weight: 1,
              weight2: 1,
              mean: Number(row.depth),
              m2: 0,
              tide: Number(row.tide ?? 0),
              passes: 1,
              first: Number(row.day),
              last: Number(row.day),
            },
            days,
          );
        }
        for (const ref of [0, 1]) {
          const m = byReference[ref];
          // Sample rate cannot increase this hour's total weight. Preserve spread.
          if (m) {
            m.m2 /= m.weight;
            m.weight = 1;
            m.weight2 = 1;
          }
          save(py, px, 0, hour, ref, m);
        }
      }
      let level = 0;
      let tided: Moments | undefined;
      let m: Moments | undefined;
      for (;;) {
        const raw = roots.all(py, px, level, 0);
        const reduced = roots.all(py, px, level, 1);
        const hasParent = !!db
          .prepare(
            "SELECT 1 FROM cell_moments WHERE py=? AND px=? AND level=? LIMIT 1",
          )
          .get(py, px, level + 1);
        if (!hasParent && raw.length <= FANOUT && reduced.length <= FANOUT) {
          tided = merge(reduced, days);
          m = tided ?? merge(raw, days);
          break;
        }
        // Promote only dense histories. A cell visited once stores one summary,
        // not a chain of identical singleton ancestors.
        if (!hasParent)
          touched = new Set(
            db
              .prepare(
                "SELECT DISTINCT bucket FROM cell_moments WHERE py=? AND px=? AND level=?",
              )
              .all(py, px, level)
              .map((r) => Number(r.bucket)),
          );
        touched = new Set([...touched].map((b) => Math.floor(b / FANOUT)));
        for (const bucket of touched)
          for (const ref of [0, 1])
            save(
              py,
              px,
              level + 1,
              bucket,
              ref,
              merge(
                children.iterate(
                  py,
                  px,
                  level,
                  ref,
                  bucket * FANOUT,
                  (bucket + 1) * FANOUT,
                ),
                days,
              ),
            );
        level++;
      }
      if (!m) return;
      return {
        py,
        px,
        m: m.mean,
        d: momentSigma(m) / 1.25,
        ...(tided ? { t: m.tide } : {}),
        passes: m.passes,
        first: m.first,
        last: m.last,
      };
    },
  };
}
