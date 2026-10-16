"""Track QC: flag impossible values, position jumps and depth spikes along each track.

QC runs on each ingest batch as it lands, along each file's soundings: a submitted
file is a contiguous piece of one vessel's track. Its windows run one day of a file at
a time, with the adjacent days' soundings as context, so memory follows a day of one
logger, not the size of a file. A transit's first and last few soundings are judged
against one side only.

Follows NOAA Office of Coast Survey's CSB processing tool, with its thresholds as
starting values. Rejection is one-sided: a spike deeper than the track around it is
rejected, a shoaler one is kept as `unconfirmed`, because it may be a rock or a
new shoal. QC writes flags and never deletes points.
"""

import logging

from .sources import EARLIEST

log = logging.getLogger(__name__)

QC_VERSION = 2

# Flags: reject (left out of everything), review (kept, looked at later),
# unconfirmed (a shoal kept out of cell depths, areas and contours, and published by
# the overlay as a low-reliability sounding), and confirmed (written by the cells step
# for a track spike that its cell agrees with, or that other shoals of another vessel
# or pass, or enough of them, confirm; it then counts like any other sounding). A
# point can carry both an unconfirmed and a confirmed flag: confirmed wins. A reject
# flag wins over both.
TRACK_REASONS = ["sentinel", "time", "very_shallow", "jump", "flatline", "spike"]

MAX_DEPTH_M = 11_000
SHALLOW_M = 0.5
TRANSIT_GAP = "4 hours"
TRANSIT_SPAN_S = 7 * 86_400
MAX_SPEED_KN = 20
SPIKE_WINDOW = 5  # soundings either side
SPIKE_ABS_M = 2.0
SPIKE_REL = 0.10
# A sounder that has lost bottom often holds its last depth: the same value over this
# far is a stuck reading, not a flat seabed. On the Lynn Canal sample, runs this long
# were a median 17% off the other vessels' depths there, against 5% for shorter ones.
FLAT_M = 1000
FLAT_MIN_SOUNDINGS = 3


def _at(a: str, column: str) -> str:
    return f"{a}({column}) OVER w" if a else column


def _distance(a: str, b: str) -> str:
    """Metres between soundings `a` and `b`, each "" (this one), "lag" or "lead" along the transit."""
    # Equirectangular, well under 1% off at these spacings; longitude wraps at the antimeridian.
    dx = f"((({_at(b, 'lon')} - {_at(a, 'lon')} + 540) % 360) - 180) * cos(radians({_at(a, 'lat')})) * 111320"
    dy = f"({_at(b, 'lat')} - {_at(a, 'lat')}) * 110540"
    return f"sqrt(({dx}) ^ 2 + ({dy}) ^ 2)"


def _speed(a: str, b: str) -> str:
    """Knots between soundings `a` and `b`, each "" (this one), "lag" or "lead" along the transit."""
    # Pairs less than a second apart count as one second, since most providers write
    # whole seconds; it hides jumps of under about 10 m between them.
    dt = f"greatest(abs(epoch({_at(b, 'time')}) - epoch({_at(a, 'time')})), 1)"
    return f"{_distance(a, b)} / {dt} * 1.943844"


# Order along a file's track: time, then the order soundings were written in.
ORDER = 'time, "row"'
TRACK_COLUMNS = ["point_id", "row", "time", "lon", "lat", "d", "transit", "cell_id"]


def with_context(source: str, k: int) -> str:
    """CTEs giving `windowed`: `source`'s soundings, each day of each file with the last `k`
    soundings of the file's previous day and the first `k` of its next, marked `context`.

    Windows then run per file and day, so their memory is a day of one logger's soundings,
    not a file's. `k` from the adjacent day is enough: a transit that runs through a whole
    day has a fix at least every 4 hours, so at least 6 that day, and a day with fewer
    than `k` soundings can only start or end a transit. Spikes take their context after
    jumps are removed, so a day of 5 or 6 soundings with jumps among them can leave the
    next day's first windows a sounding or two short.
    """
    fields = ", ".join(f"'{c}': \"{c}\"" for c in TRACK_COLUMNS)
    return f"""edges AS (
  SELECT file_id, day,
    lag(last_k) OVER (PARTITION BY file_id ORDER BY day) AS before,
    lead(first_k) OVER (PARTITION BY file_id ORDER BY day) AS after
  FROM (
    SELECT file_id, day, max_by(s, o, {k}) AS last_k, min_by(s, o, {k}) AS first_k
    FROM (SELECT file_id, day, {{'t': time, 'r': "row"}} AS o, {{{fields}}} AS s FROM {source})
    GROUP BY ALL
  )
),
windowed AS (
  SELECT file_id, day, {", ".join(f'"{c}"' for c in TRACK_COLUMNS)}, false AS context
  FROM {source}
  UNION ALL BY NAME
  SELECT file_id, day, unnest(list_concat(coalesce(before, []), coalesce(after, [])),
    recursive := true), true AS context
  FROM edges
)"""


# Each step is a temp table, which spills past the memory limit, and every window runs
# per file and day, or per transit within that.
TRACK_QC = [
    f"""
CREATE OR REPLACE TEMP TABLE qc_points AS
SELECT p.point_id, p.file_id, p."row", p.time, p.lon, p.lat, p.depth_raw AS d, p.cell_id,
  date_trunc('day', p.time) AS day,
  CASE
    WHEN p.depth_raw <= 0 OR p.depth_raw > {MAX_DEPTH_M} THEN 'sentinel'
    WHEN p.time < TIMESTAMP '{EARLIEST}' OR p.time > f.arrival + INTERVAL 1 DAY THEN 'time'
  END AS reason
FROM lake.points p JOIN lake.files f USING (file_id) WHERE p.batch_id = $batch""",
    f"""
-- A transit ends at a gap of more than 4 hours, and every 7 days. The gap before a day's
-- first sounding is measured from the file's previous day, and transits are numbered
-- across days by a running total of each day's starts.
CREATE OR REPLACE TEMP TABLE qc_track AS
WITH track AS (SELECT * EXCLUDE (reason) FROM qc_points WHERE reason IS NULL),
days AS (
  SELECT file_id, day, lag(last_t) OVER (PARTITION BY file_id ORDER BY day) AS prev_t
  FROM (SELECT file_id, day, max(time) AS last_t FROM track GROUP BY ALL)
),
gaps AS (
  SELECT t.*, (coalesce(t.time - lag(t.time) OVER w, t.time - d.prev_t) IS NULL
      OR coalesce(t.time - lag(t.time) OVER w, t.time - d.prev_t) > INTERVAL '{TRANSIT_GAP}'
    )::INTEGER AS starts
  FROM track t JOIN days d USING (file_id, day)
  WINDOW w AS (PARTITION BY t.file_id, t.day ORDER BY t.time, t."row")
),
within AS (
  SELECT *, sum(starts) OVER (PARTITION BY file_id, day ORDER BY {ORDER}
    ROWS UNBOUNDED PRECEDING) AS seg_in_day
  FROM gaps
),
offsets AS (
  SELECT file_id, day, coalesce(sum(n) OVER (PARTITION BY file_id ORDER BY day
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
  FROM (SELECT file_id, day, sum(starts) AS n FROM gaps GROUP BY ALL)
),
segs AS (
  SELECT w.* EXCLUDE (starts, seg_in_day), o.before + w.seg_in_day AS seg
  FROM within w JOIN offsets o USING (file_id, day)
),
seg_starts AS (SELECT file_id, seg, min(time) AS t0 FROM segs GROUP BY ALL)
SELECT s.* EXCLUDE (seg),
  s.seg * 100000 + floor(epoch(s.time - a.t0) / {TRANSIT_SPAN_S})::BIGINT AS transit
FROM segs s JOIN seg_starts a USING (file_id, seg)""",
    f"""
CREATE OR REPLACE TEMP TABLE qc_jumps AS
WITH {with_context("qc_track", 1)},
legs AS (
  SELECT *, {_speed("lag", "")} AS speed_in, {_speed("", "lead")} AS speed_out,
    {_speed("lag", "lead")} AS speed_past
  FROM windowed
  WINDOW w AS (PARTITION BY file_id, day, transit ORDER BY {ORDER})
)
-- A position off the line through its neighbors: both legs faster than 20 kn and than
-- twice the speed straight past it, so a fast ship's track isn't a jump. A transit's
-- first and last soundings have one leg and can't be judged this way. (least and
-- greatest skip NULLs, so the ends are excluded explicitly.)
SELECT point_id FROM legs
WHERE NOT context AND speed_past IS NOT NULL
  AND least(speed_in, speed_out) > greatest({MAX_SPEED_KN}, 2 * speed_past)""",
    f"""
-- A run of one depth along a transit, held over {FLAT_M} m or more.
-- ponytail: a run crossing midnight is measured a day at a time, so one that's long only
-- in total is missed; carry runs across days if stuck sounders slip through that way
CREATE OR REPLACE TEMP TABLE qc_flat AS
WITH steps AS (
  SELECT point_id, file_id, day, transit, "row", time,
    d IS DISTINCT FROM lag(d) OVER w AS starts, {_distance("lag", "")} AS step
  FROM qc_track WHERE point_id NOT IN (SELECT point_id FROM qc_jumps)
  WINDOW w AS (PARTITION BY file_id, day, transit ORDER BY {ORDER})
),
runs AS (
  SELECT *, sum(starts::INTEGER) OVER (PARTITION BY file_id, day, transit ORDER BY {ORDER}
    ROWS UNBOUNDED PRECEDING) AS run
  FROM steps
)
SELECT point_id FROM runs
WINDOW r AS (PARTITION BY file_id, day, transit, run)
QUALIFY sum(CASE WHEN NOT starts THEN step END) OVER r >= {FLAT_M}
  AND count(*) OVER r >= {FLAT_MIN_SOUNDINGS}""",
    f"""
CREATE OR REPLACE TEMP TABLE qc_spikes AS
WITH clean AS (SELECT * FROM qc_track WHERE point_id NOT IN (
  SELECT point_id FROM qc_jumps UNION ALL SELECT point_id FROM qc_flat)),
{with_context("clean", SPIKE_WINDOW)},
sizes AS (SELECT file_id, transit, count(*) AS n FROM clean GROUP BY ALL),
medians AS (
  SELECT point_id, file_id, transit, d, context,
    median(d) OVER (PARTITION BY file_id, day, transit ORDER BY {ORDER}
      ROWS BETWEEN {SPIKE_WINDOW} PRECEDING AND {SPIKE_WINDOW} FOLLOWING) AS med
  FROM windowed
)
SELECT m.point_id, m.d, m.med, s.n FROM medians m JOIN sizes s USING (file_id, transit)
WHERE NOT m.context""",
]

TRACK_FLAGS = f"""
SELECT point_id, cell_id, 'reject' AS flag, reason FROM qc_points WHERE reason IS NOT NULL
UNION ALL
SELECT point_id, cell_id, 'review', 'very_shallow' FROM qc_points WHERE d > 0 AND d < {SHALLOW_M}
UNION ALL
SELECT point_id, cell_id, 'reject', 'jump' FROM qc_jumps JOIN qc_points USING (point_id)
UNION ALL
SELECT point_id, cell_id, 'reject', 'flatline' FROM qc_flat JOIN qc_points USING (point_id)
UNION ALL
SELECT s.point_id, p.cell_id, CASE WHEN s.d > s.med THEN 'reject' ELSE 'unconfirmed' END, 'spike'
FROM qc_spikes s JOIN qc_points p USING (point_id)
WHERE s.n >= 3 AND abs(s.d - s.med) > {SPIKE_ABS_M} + {SPIKE_REL} * s.med
"""


def run_batch(con, batch_id: int, fresh=False):
    """Replace one ingest batch's track flags. `fresh` batches have none to delete."""
    params = {"batch": batch_id}
    if not fresh:
        con.execute(
            f"""DELETE FROM lake.qc_flags WHERE qc_version = {QC_VERSION}
            AND list_contains({TRACK_REASONS}, reason)
            AND cell_id IN (SELECT DISTINCT cell_id FROM lake.points WHERE batch_id = $batch)
            AND point_id IN (SELECT point_id FROM lake.points WHERE batch_id = $batch)""",
            params,
        )
    for statement in TRACK_QC:
        con.execute(statement, params if "$batch" in statement else None)
    con.execute(
        f"""INSERT INTO lake.qc_flags BY NAME
        SELECT *, {QC_VERSION} AS qc_version FROM ({TRACK_FLAGS})"""
    )
    con.execute(
        "DROP TABLE qc_points; DROP TABLE qc_track; DROP TABLE qc_jumps; DROP TABLE qc_flat;"
        " DROP TABLE qc_spikes"
    )
    con.execute("DELETE FROM lake.qc_batches WHERE batch_id = $batch", params)
    con.execute(f"INSERT INTO lake.qc_batches VALUES ($batch, {QC_VERSION})", params)


def run(con, missing_only=False) -> int:
    """QC every batch, or only those not yet QC'd at this version. Returns batches run."""
    batches = [
        b
        for (b,) in con.execute(
            f"""SELECT DISTINCT batch_id FROM lake.points
            WHERE NOT $missing_only OR batch_id NOT IN (
              SELECT batch_id FROM lake.qc_batches WHERE qc_version = {QC_VERSION})
            ORDER BY 1""",
            {"missing_only": missing_only},
        ).fetchall()
    ]
    for batch_id in batches:
        con.execute("BEGIN")
        run_batch(con, batch_id)
        con.execute("COMMIT")
    log.info("qc: %d batches", len(batches))
    return len(batches)
