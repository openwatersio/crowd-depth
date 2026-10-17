"""QC as one pass over each file: the reference the day-split QC must agree with.

Its windows hold a whole file, which is why ingest doesn't use it.
"""

from grid.cells import OTHER_PASS, SUPPORT
from grid.qc import (
    FLAT_M,
    FLAT_MIN_SOUNDINGS,
    MAX_DEPTH_M,
    MAX_SPEED_KN,
    SHALLOW_M,
    SPIKE_ABS_M,
    SPIKE_REL,
    SPIKE_WINDOW,
    TRANSIT_GAP,
    TRANSIT_SPAN_S,
)


def _distance(a: str, b: str) -> str:
    """Metres between soundings `a` and `b`, each "" (this one), "lag" or "lead" along the transit."""
    lon_a, lat_a = (f"{a}({c}) OVER w" if a else c for c in ("lon", "lat"))
    lon_b, lat_b = (f"{b}({c}) OVER w" if b else c for c in ("lon", "lat"))
    dx = f"((({lon_b} - {lon_a} + 540) % 360) - 180) * cos(radians({lat_a})) * 111320"
    dy = f"({lat_b} - {lat_a}) * 110540"
    return f"sqrt(({dx}) ^ 2 + ({dy}) ^ 2)"


def _speed(a: str, b: str) -> str:
    """Knots between soundings `a` and `b`, each "" (this one), "lag" or "lead" along the transit."""
    lon_a, lat_a, time_a = (f"{a}({c}) OVER w" if a else c for c in ("lon", "lat", "time"))
    lon_b, lat_b, time_b = (f"{b}({c}) OVER w" if b else c for c in ("lon", "lat", "time"))
    # Equirectangular distance, well under 1% off at these spacings; longitude wraps
    # at the antimeridian. Pairs less than a second apart count as one second, since
    # most providers write whole seconds; it hides jumps of under about 10 m between them.
    dx = f"((({lon_b} - {lon_a} + 540) % 360) - 180) * cos(radians({lat_a})) * 111320"
    dy = f"({lat_b} - {lat_a}) * 110540"
    dt = f"greatest(abs(epoch({time_b}) - epoch({time_a})), 1)"
    return f"sqrt(({dx}) ^ 2 + ({dy}) ^ 2) / {dt} * 1.943844"


TRACK_QC = f"""
WITH p AS (
  SELECT p.point_id, p.file_id, p."row", p.time, p.lon, p.lat, p.depth_raw AS d, f.arrival
  FROM lake.points p JOIN lake.files f USING (file_id) WHERE p.batch_id = $batch
),
basic AS (
  SELECT point_id,
    CASE
      WHEN d <= 0 OR d > {MAX_DEPTH_M} THEN 'sentinel'
      WHEN time < TIMESTAMP '2000-01-01' OR time > arrival + INTERVAL 1 DAY THEN 'time'
    END AS reason
  FROM p
),
track AS (
  SELECT p.* FROM p JOIN basic USING (point_id) WHERE basic.reason IS NULL
),
segments AS (
  SELECT *, sum(CASE WHEN gap IS NULL OR gap > INTERVAL '{TRANSIT_GAP}' THEN 1 ELSE 0 END)
    OVER (PARTITION BY file_id ORDER BY time, file_id, "row") AS seg
  FROM (SELECT *, time - lag(time) OVER (PARTITION BY file_id ORDER BY time, file_id, "row") AS gap
        FROM track)
),
transits AS (
  -- A transit ends at a gap of more than 4 hours, and every 7 days.
  SELECT *, seg * 100000 + floor(epoch(time - min(time) OVER (PARTITION BY file_id, seg))
    / {TRANSIT_SPAN_S})::BIGINT AS transit
  FROM segments
),
legs AS (
  SELECT *, {_speed("lag", "")} AS speed_in, {_speed("", "lead")} AS speed_out,
    {_speed("lag", "lead")} AS speed_past
  FROM transits
  WINDOW w AS (PARTITION BY file_id, transit ORDER BY time, file_id, "row")
),
jumps AS (
  -- A position off the line through its neighbors: both legs faster than 20 kn and
  -- than twice the speed straight past it, so a fast ship's track isn't a jump. A
  -- transit's first and last soundings have one leg and can't be judged this way.
  SELECT point_id FROM legs
  -- (least and greatest skip NULLs, so the ends are excluded explicitly.)
  WHERE speed_past IS NOT NULL
    AND least(speed_in, speed_out) > greatest({MAX_SPEED_KN}, 2 * speed_past)
),
flat AS (
  SELECT point_id FROM (
    SELECT *, sum(starts::INTEGER) OVER (PARTITION BY file_id, transit ORDER BY time, file_id, "row"
      ROWS UNBOUNDED PRECEDING) AS run
    FROM (SELECT *, d IS DISTINCT FROM lag(d) OVER w AS starts, {_distance("lag", "")} AS step
      FROM legs WHERE point_id NOT IN (SELECT point_id FROM jumps)
      WINDOW w AS (PARTITION BY file_id, transit ORDER BY time, file_id, "row"))
  )
  QUALIFY sum(CASE WHEN NOT starts THEN step END) OVER (PARTITION BY file_id, transit, run) >= {FLAT_M}
    AND count(*) OVER (PARTITION BY file_id, transit, run) >= {FLAT_MIN_SOUNDINGS}
),
spikes AS (
  SELECT point_id, d,
    median(d) OVER (PARTITION BY file_id, transit ORDER BY time, file_id, "row"
      ROWS BETWEEN {SPIKE_WINDOW} PRECEDING AND {SPIKE_WINDOW} FOLLOWING) AS med,
    count(*) OVER (PARTITION BY file_id, transit) AS n
  FROM legs WHERE point_id NOT IN (SELECT point_id FROM jumps UNION ALL SELECT point_id FROM flat)
)
SELECT point_id, 'reject' AS flag, reason FROM basic WHERE reason IS NOT NULL
UNION ALL
SELECT point_id, 'review', 'very_shallow' FROM p WHERE d > 0 AND d < {SHALLOW_M}
UNION ALL
SELECT point_id, 'reject', 'jump' FROM jumps
UNION ALL
SELECT point_id, 'reject', 'flatline' FROM flat
UNION ALL
SELECT point_id, CASE WHEN d > med THEN 'reject' ELSE 'unconfirmed' END, 'spike'
FROM spikes
WHERE n >= 3 AND abs(d - med) > {SPIKE_ABS_M} + {SPIKE_REL} * med
"""


def windowed_confirm(step: float) -> str:
    """Shoal confirmation as a range window of `step` either side on ln(depth + 40): the
    reference the binned confirmation must contain at ln(1.05) and stay within at twice it.
    Its window can hold every candidate of a cell, which is why cells don't use it."""
    return f"""
SELECT point_id FROM (
  SELECT point_id, vessel, time,
    min(vessel) OVER w AS vmin, max(vessel) OVER w AS vmax,
    min(time) OVER w AS tmin, max(time) OVER w AS tmax, count(*) OVER w AS support
  FROM classed WHERE outlier = 'shoal'
  WINDOW w AS (PARTITION BY tile_id, level, cr, cc ORDER BY ln(d + 40)
    RANGE BETWEEN {step} PRECEDING AND {step} FOLLOWING)
)
WHERE vmin <> vessel OR vmax <> vessel OR support >= {SUPPORT}
  OR tmax - time > INTERVAL '{OTHER_PASS}' OR time - tmin > INTERVAL '{OTHER_PASS}'"""
