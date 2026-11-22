import type { DatabaseSync } from "node:sqlite";
import type { Cell } from "./cells.js";
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
  const children = db.prepare(`SELECT ${columns} FROM cell_moments
    WHERE py=? AND px=? AND level=? AND reference=? AND bucket>=? AND bucket<? ORDER BY bucket`);
  const roots = db.prepare(`SELECT ${columns} FROM cell_moments
    WHERE py=? AND px=? AND level=? AND reference=? ORDER BY bucket LIMIT 257`);
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
