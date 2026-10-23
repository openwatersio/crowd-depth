"""Grid cells: shoal-biased statistics on a variable-resolution grid, one 10° partition at a time.

The base grid is 1/3″ of latitude (about 10 m). Columns are `k` base steps wide so
cells stay roughly square; `k` divides 1,200, so 1″ (3×3 base) and 3″ (9×9 base)
cells tile each 1° tile exactly. A cell's `level` is its size in base steps: 1, 3
or 9. Where two or more vessels sounded a 1″ cell, its base cells publish on their
own; a lone track is aggregated to 1″ or 3″, so one vessel's track alone never
publishes finer than its positions hold.
"""

import hashlib
import itertools
import logging
import math
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from . import catalog, definitions, qc, statistic
from .catalog import BASE_ROW, MIN_DEPTH_M, checkpoint
from .definitions import CELLS, QC
from .qc import HAZARD_M, MAX_DEPTH_M, QC_VERSION, SHALLOW_M, TRACK_REASONS

log = logging.getLogger(__name__)

GRID_VERSION = 9
BATCH_POINTS = 5_000_000
BASE = CELLS["rows_per_degree"]  # base rows per 1° tile
MIN_VESSELS = 2
CELL_REASONS = [
    "cell_deep",
    "cell_shoal",
    "cell_unjudged",
    "cell_confirmed",
    "consensus_deep",
    "consensus_far_deep",
    "consensus_shoal",
]
# A sounding of the same vessel this far apart in time is another pass.
OTHER_PASS = "4 hours"
STEPS = CELLS["column_steps_divide"]
DIVISORS = [d for d in range(1, STEPS + 1) if STEPS % d == 0]


def k_for(lat0: int) -> int:
    """Column width in base steps for the 1° tile whose southern edge is lat0."""
    want = max(1, round(1 / math.cos(math.radians(lat0 + 0.5))))
    return next(d for d in DIVISORS if d >= want)


# k for each tile row, indexed by lat0 + 91 (SQL lists are 1-based).
K_LIST = "[" + ",".join(str(k_for(lat0)) for lat0 in range(-90, 90)) + "]"


# CATZOC C depth tolerance, 2 m + 5% of depth: the least vertical uncertainty a cell is
# published with, until validation supports a tighter one.
TOLERANCE_M, TOLERANCE_PER_M = 2, 0.05
# A confirmed shoal stays confirmed only within the tolerance of the other vessels' median
# for its pixel, where at least this many other vessels sounded the pixel, or failing that
# its 3x3: echoes off piers and moored hulls that many vessels read confirm each other.
SHOAL_CHECK_VESSELS = CELLS["shoal_check_vessels"]


def tolerance(d: str) -> str:
    return f"({TOLERANCE_M} + {TOLERANCE_PER_M} * {d})"


def levels(source: str, dest: str) -> str:
    """Statements creating `dest`: `source` with each point's level and cell. Base cells
    where two or more vessels sounded their 1″ cell, else 1″ cells where two or more
    sounded the 3″ cell, else 3″ cells.

    Counted with GROUP BY rather than window functions, which hold a whole cell in
    memory (a mooring cell keeps growing for as long as a boat logs there). The level
    per 1″ cell goes in a small table of its own before the join, so DuckDB builds the
    join on it rather than on the points.
    """
    return f"""
CREATE OR REPLACE TEMP TABLE levels AS
WITH v1 AS (
  SELECT tile_id, r // 3 AS r1, c // 3 AS c1, count(DISTINCT vessel) AS n
  FROM {source} GROUP BY ALL
),
v3 AS (
  SELECT tile_id, r1 // 3 AS r3, c1 // 3 AS c3, count(DISTINCT vessel) AS n
  FROM (SELECT DISTINCT tile_id, r // 3 AS r1, c // 3 AS c1, vessel FROM {source})
  GROUP BY ALL
)
SELECT v1.tile_id, v1.r1, v1.c1, CASE WHEN v1.n >= {MIN_VESSELS} THEN 1
  WHEN v3.n >= {MIN_VESSELS} THEN 3 ELSE 9 END AS level
FROM v1 JOIN v3 ON v3.tile_id = v1.tile_id AND v3.r3 = v1.r1 // 3 AND v3.c3 = v1.c1 // 3;

CREATE OR REPLACE TEMP TABLE {dest} AS
SELECT s.*, l.level, s.r // l.level AS cr, s.c // l.level AS cc
FROM {source} s JOIN levels l ON l.tile_id = s.tile_id AND l.r1 = s.r // 3 AND l.c1 = s.c // 3;
"""


CELL = ["tile_id", "level", "cr", "cc"]
# About how many soundings a cell's median, spread and vessels' medians are taken from. These
# aggregates hold their values in memory, and a boat logging at its mooring fills one
# cell for as long as it logs. Larger cells are sampled by point id, the same sample
# every run; min, max, counts and confirmed shoals still use every sounding.
CELL_SAMPLE = 1_000_000


def sample(source: str, keys: list[str], name: str) -> str:
    """`source` with a column `name` marking a fixed sample of CELL_SAMPLE per group of `keys`.

    `source` is read twice, so it must be a table.
    """
    k = ", ".join(keys)
    return f"""(SELECT s.*,
      hash(s.point_id) % greatest(1, ceil(n.n / {CELL_SAMPLE}))::UBIGINT = 0 AS {name}
    FROM {source} s JOIN (SELECT {k}, count(*) AS n FROM {source} GROUP BY ALL) n USING ({k}))"""


# Soundings within tolerance of a shoal that make it a feature rather than noise.
SUPPORT = 3
# Other vessels that must agree with each other to disprove a shoal one vessel read.
DISPROVE = 3
# A disproved shoal shallower than HAZARD_M may still be a hazard one boat found and
# the others passed beside, so it stays an unconfirmed shoal rather than a reject: out
# of depths, and published, though the surface is drawn over it. Deeper, it's a stray echo.

# A unit's points are classified in steps, each a temp table that spills past the
# memory limit (a MATERIALIZED CTE would hold its whole result in memory), and the cell
# and flag queries both read the result.
# A candidate shoal is confirmed by another candidate from another vessel or another
# pass within its tolerance, or by SUPPORT or more candidates agreeing, so a feature a
# single track crosses, such as a channel edge, isn't mistaken for noise. Only
# candidates count: the cell's ordinary soundings are what it stands out from. The
# tolerance, 2 m + 5% of depth, is 5% of (depth + 40 m), a fixed step of ln(1.05) on a
# scale of ln(depth + 40). Candidates are binned by that step and each is checked
# against its own and the adjacent bins, so the work is linear in the candidates
# however many agree. That reaches up to two steps, about 10%, so it confirms a little
# more than the tolerance, never less; more confirmed shoals only make cells shoaler.
# A reading under SHALLOW_M is mostly a sounder's junk (a bubble, a hull echo), and two
# boats' junk agrees as readily as two boats' shoal, so it neither confirms nor is
# confirmed: it stays an unconfirmed candidate, out of the cell's depth. It's the raw
# reading that counts: a corrected depth over a real drying shoal is honestly negative.
# A noisy track's shoaler spike (`hunting`, qc.noisy) is held the same way: the shoal
# side of a sounder hunting between echoes agrees with itself.
CONFIRM = f"""
CREATE OR REPLACE TEMP TABLE confirmed AS
WITH shoals AS (
  SELECT point_id, tile_id, level, cr, cc, vessel, time,
    floor(ln(d + 40) / {math.log(1.05)})::BIGINT AS bin
  FROM classed WHERE outlier = 'shoal' AND raw >= {SHALLOW_M} AND NOT hunting
),
bins AS (
  SELECT tile_id, level, cr, cc, bin, count(*) AS n, min(vessel) AS vmin,
    max(vessel) AS vmax, min(time) AS tmin, max(time) AS tmax
  FROM shoals GROUP BY ALL
),
near AS (
  SELECT tile_id, level, cr, cc, bin + o AS bin, sum(n) AS support, min(vmin) AS vmin,
    max(vmax) AS vmax, min(tmin) AS tmin, max(tmax) AS tmax
  FROM bins, (VALUES (-1), (0), (1)) AS t(o) GROUP BY ALL
)
SELECT s.point_id FROM shoals s JOIN near n USING (tile_id, level, cr, cc, bin)
WHERE n.vmin <> s.vessel OR n.vmax <> s.vessel OR n.support >= {SUPPORT}
  OR n.tmax - s.time > INTERVAL '{OTHER_PASS}' OR s.time - n.tmin > INTERVAL '{OTHER_PASS}';
"""

# Consensus: each sounding against the other vessels nearby, since a sounder that has
# lost bottom is wrong the whole way along its track, so QC along the track can't see
# it. Each vessel votes once per 3″ block (9 base rows): its median depth there, from
# soundings QC accepted or marked noisy. A sounding is judged against the other vessels'
# votes in the 3x3 blocks around its own, each vessel once, wherever two or more voted
# (and on the deep side alone wherever one did, below). Deeper than
# their consensus by more than the tolerance, it's rejected. Shoaler by more than that,
# it's disproved when three or more of them agree with the consensus, unless another
# vessel read the same depth: one of its soundings, unconfirmed ones included, in the
# same block and within the shoal's own tolerance (2 m + 5%) either way. A disproved
# shoal is rejected at HAZARD_M or deeper and kept unconfirmed shallower. Every sounder
# in deep water throws stray shallow echoes, at all sorts of depths, so a shoaler or
# deeper reading nearby doesn't count; two vessels reading one depth does. A shoal
# that isn't disproved goes on to the cell's own shoal confirmation. A reading under
# SHALLOW_M neither corroborates a shoal nor is corroborated, as in CONFIRM. The
# tolerance is the larger of 2 m + 5% of the consensus and three times the spread of
# the votes, so it widens on slopes, where vessels a block apart honestly disagree.
# Where only one other vessel voted, the consensus can't tell a slope from a lost bottom
# within the tolerance, but a sounding deeper than lone_deep_factor times every other
# vessel's vote, plus lone_deep_abs_m, is no slope: it's rejected (consensus_far_deep),
# as it is wherever more vessels voted. Rejecting the deep side errs safe. A vote counts
# as at least lone_deep_floor_m, since a sounder reading junk near the surface votes too,
# and alone would make every real depth beside it look far deeper. A noisy
# track's soundings (qc.noisy) vote, and can be rejected here, but are never kept as
# unconfirmed shoals, which would stop the surface filling over them.
# A vessel's vote is the median of a fixed sample, as cells' are, so one moored in a
# block for a year costs fixed memory; a vote of the others is the median of at most 9.
# ponytail: neighbors stop at tile edges; look across them if a tile's edge rows matter
FAR = (
    f"{QC['lone_deep_factor']} * greatest(c.most, {QC['lone_deep_floor_m']})"
    f" + {QC['lone_deep_abs_m']}"
)
CONSENSUS = f"""
CREATE OR REPLACE TEMP TABLE votes AS
SELECT tile_id, br, bc, vessel,
  median(d) FILTER (WHERE (flag IS NULL OR flag = 'noisy') AND keep) AS med
FROM {sample("unit_points", ["tile_id", "br", "bc", "vessel"], "keep")} GROUP BY ALL;

CREATE OR REPLACE TEMP TABLE consensus AS
WITH others AS (
  SELECT a.tile_id, a.br, a.bc, a.vessel, b.vessel AS other,
    median(b.med) AS med
  FROM (SELECT DISTINCT tile_id, br, bc, vessel FROM votes) a JOIN votes b
    ON b.tile_id = a.tile_id AND b.br BETWEEN a.br - 1 AND a.br + 1
    AND b.bc BETWEEN a.bc - 1 AND a.bc + 1 AND b.vessel <> a.vessel
  GROUP BY ALL
)
SELECT tile_id, br, bc, vessel, median(med) AS m, coalesce(mad(med), 0) AS spread,
  list(med) FILTER (WHERE med IS NOT NULL) AS meds, count(med) AS n, max(med) AS most
FROM others GROUP BY ALL HAVING count(med) >= 1;
DROP TABLE votes;

CREATE OR REPLACE TEMP TABLE consensus_judged AS
SELECT p.point_id, p.tile_id, p.br, p.bc, p.vessel, p.d, p.raw, p.hunting, p.flag, c.m, c.meds, c.n,
  greatest(2 + 0.05 * c.m, 3 * 1.4826 * c.spread) AS tol,
  p.d > {FAR} AS far
FROM unit_points p JOIN consensus c
  ON c.tile_id = p.tile_id AND c.br = p.br AND c.bc = p.bc AND c.vessel = p.vessel
WHERE p.r >= $rlo AND p.r < $rhi
  AND (p.d > {FAR}
    OR (c.n >= 2 AND (p.d > c.m + greatest(2 + 0.05 * c.m, 3 * 1.4826 * c.spread)
      OR p.d < c.m - greatest(2 + 0.05 * c.m, 3 * 1.4826 * c.spread))));

CREATE OR REPLACE TEMP TABLE consensus_rejects AS
WITH shoals AS (
  SELECT * FROM consensus_judged
  WHERE d < m AND flag IS DISTINCT FROM 'noisy'
    AND len(list_filter(meds, x -> abs(x - m) <= tol)) >= {DISPROVE}
),
-- The shoal candidates' blocks, one row per depth read there with the least and
-- greatest vessel that read it, so a busy harbor block costs its distinct depths, not
-- its soundings times the candidates. A depth some other vessel read has a least or
-- greatest vessel other than the shoal's.
depths AS (
  SELECT tile_id, br, bc, d, min(vessel) AS vmin, max(vessel) AS vmax FROM unit_points
  WHERE (tile_id, br, bc) IN (SELECT tile_id, br, bc FROM shoals) AND raw >= {SHALLOW_M}
    AND flag IS DISTINCT FROM 'noisy' AND NOT hunting
  GROUP BY ALL
),
corroborated AS (
  SELECT DISTINCT s.point_id FROM shoals s JOIN depths o
    ON o.tile_id = s.tile_id AND o.br = s.br AND o.bc = s.bc
    AND abs(o.d - s.d) <= 2 + 0.05 * s.d AND (o.vmin <> s.vessel OR o.vmax <> s.vessel)
    AND s.raw >= {SHALLOW_M} AND NOT s.hunting
)
SELECT point_id, 'reject' AS flag,
  CASE WHEN n >= 2 AND d > m + tol THEN 'consensus_deep' ELSE 'consensus_far_deep' END AS reason
FROM consensus_judged WHERE d > m
UNION ALL
SELECT point_id, CASE WHEN d < {HAZARD_M} THEN 'unconfirmed' ELSE 'reject' END,
  'consensus_shoal'
FROM shoals WHERE point_id NOT IN (SELECT point_id FROM corroborated);
DROP TABLE consensus_judged;
DROP TABLE consensus;
"""

CLASSIFY = f"""
CREATE OR REPLACE TEMP TABLE unit_points AS
WITH flags AS (
  -- A stuck run kept as an unconfirmed shoal never sets depths, even agreeing with
  -- itself: it stays out of cells, as a reject does, and publishes from its flag.
  SELECT point_id, CASE WHEN reason = 'flatline' THEN 'reject' ELSE flag END AS flag,
    flag = 'unconfirmed' AND reason = 'track_noise' AS hunting
  FROM lake.qc_flags
  WHERE cell_id = $partition AND qc_version = {QC_VERSION} AND list_contains({TRACK_REASONS}, reason)
    AND flag IN ('reject', 'unconfirmed', 'noisy')
),
pts AS (
  SELECT a.point_id, a.tile_id, a.cell_id, a.unique_id AS vessel, a.time, a.lon, a.lat,
    a.depth AS d, a.depth_raw AS raw, coalesce(f.hunting, false) AS hunting, a.tide IS NOT NULL AS tided, a.offset_m IS NOT NULL AS calibrated, a.sigma,
    f.flag,
    a.tile_id // 360 - 90 AS lat0, a.tile_id % 360 - 180 AS lon0,
    {K_LIST}[a.tile_id // 360 - 90 + 91] AS k
  FROM tile_points a LEFT JOIN flags f USING (point_id)
  -- The unit's rows and a 3″ row either side, which consensus reads.
  WHERE a.r BETWEEN $rlo - 9 AND $rhi + 8 AND f.flag IS DISTINCT FROM 'reject'
    -- QC rejects these too; cells never trust that QC saw every point. Judged on the raw
    -- depth: a corrected one may honestly be negative, a drying height.
    AND a.depth_raw > 0 AND a.depth_raw <= {MAX_DEPTH_M} AND a.depth >= {MIN_DEPTH_M}
    -- A run calibration found its sounder had lost the bottom sets no depths and votes in
    -- no consensus, as a reject: it publishes as shoals.
    AND NOT a.excluded AND NOT a.lost_bottom AND NOT a.awaiting_tide
),
idx AS (
  SELECT *,
    least(floor((lat - lat0) * {BASE})::INTEGER, {BASE - 1}) AS r,
    least(floor((lon - lon0) * {BASE} / k)::INTEGER, {BASE} // k - 1) AS c
  FROM pts
)
SELECT *, r // 9 AS br, c // 9 AS bc FROM idx;

{CONSENSUS}

-- A noisy track's soundings go no further: they set no depths and confirm nothing.
CREATE OR REPLACE TEMP TABLE unit_rows AS
SELECT * EXCLUDE (br, bc) FROM unit_points WHERE r >= $rlo AND r < $rhi
  AND flag IS DISTINCT FROM 'noisy' AND point_id NOT IN (SELECT point_id FROM consensus_rejects);
DROP TABLE unit_points;

{levels("unit_rows", "keyed")}
DROP TABLE unit_rows;

CREATE OR REPLACE TEMP TABLE classed AS
WITH robust AS (
  SELECT tile_id, level, cr, cc, median(d) AS med,
    greatest(1, 3 * 1.4826 * coalesce(mad(d), 0)) AS bound
  FROM {sample("keyed", CELL, "keep")} WHERE flag IS NULL AND keep GROUP BY ALL
),
classified AS (
  -- One-sided: deeper than the cell is rejected; shoaler than the cell is a candidate
  -- shoal that needs confirming. A track spike that doesn't stand out from its cell
  -- (the cell agrees with it) is accepted; one in a cell of nothing but spikes can't
  -- be judged against the cell and stays a candidate.
  SELECT k.*, CASE
      WHEN k.d > r.med + r.bound THEN 'deep'
      WHEN r.med IS NULL OR k.d < r.med - r.bound THEN 'shoal'
    END AS outlier,
    k.flag IS NOT DISTINCT FROM 'unconfirmed' AS from_track,
    -- Whether the cell had accepted soundings to judge a candidate against.
    r.med IS NOT NULL AS judged
  FROM keyed k LEFT JOIN robust r USING (tile_id, level, cr, cc)
)
SELECT * FROM classified;

{CONFIRM}
DROP TABLE keyed;

CREATE OR REPLACE TEMP TABLE kept AS
SELECT * EXCLUDE (level, cr, cc) FROM classed
-- A track spike under SHALLOW_M can't be confirmed, even by a cell that agrees with it.
WHERE (outlier IS NULL AND NOT (from_track AND (raw < {SHALLOW_M} OR hunting)))
  OR point_id IN (SELECT point_id FROM confirmed);

-- Levels again from accepted soundings only, so a vessel whose soundings were all
-- rejected can't raise another vessel's track to a finer level.
{levels("kept", "relevelled")}
DROP TABLE kept;

CREATE OR REPLACE TEMP TABLE by_cell AS SELECT * FROM {sample("relevelled", CELL, "keep_cell")};

DROP TABLE relevelled;

CREATE OR REPLACE TEMP TABLE accepted AS
SELECT * FROM {sample("by_cell", CELL + ["r", "c"], "keep_base")};
DROP TABLE by_cell;

"""

# Each vessel's median in each 2/3″ pixel, the surface's, with its median correction σ:
# one vote per vessel however fast it logs. The statistic is worked out per pixel from
# these (statistic.py), over every band's accepted soundings, so its window reads across
# bands. A cell's sounding takes its pixel's statistic, as the surface does; they differ
# only where the surface reads across a tile edge or around its interpolation.
# Each vessel's median is taken from a fixed sample of its own soundings in the pixel,
# so one boat logging a million soundings there can't sample the others out.
ENTRIES = f"""
SELECT py, px, hash(vessel) AS v, median(d) FILTER (WHERE keep_v) AS m,
  median(sigma) FILTER (WHERE keep_v) AS s
FROM {
    sample(
        "(SELECT *, r // 2 AS py, c // 2 AS px FROM group_accepted WHERE tile_id = $tile)",
        ["py", "px", "vessel"],
        "keep_v",
    )
}
GROUP BY py, px, vessel HAVING count(*) FILTER (WHERE keep_v) > 0 ORDER BY py, px, v, m
"""

STATS = f"""
CREATE OR REPLACE TEMP TABLE accepted AS
SELECT * FROM group_accepted WHERE r >= $rlo AND r < $rhi;

-- Aggregates first, as small tables, so the join placing each cell's sounding is built
-- on them: DuckDB can't spill a hash join's table, so it must never be the points.
CREATE OR REPLACE TEMP TABLE children AS
WITH votes AS (
  SELECT tile_id, level, cr, cc, r, c, vessel, median(d) FILTER (WHERE keep_v) AS m,
    min(d) FILTER (WHERE outlier = 'shoal') AS shoal
  FROM {sample("accepted", CELL + ["r", "c", "vessel"], "keep_v")} GROUP BY ALL
),
own AS (
  SELECT tile_id, level, cr, cc, r, c, median(m) AS m, min(shoal) AS shoal FROM votes GROUP BY ALL
)
-- The pixel's median of the vessels' smoothed votes less K σ, and never deeper than the
-- base cell's own vessels' median less K σ: smoothing along a track can't take a narrow
-- shoal every vessel read out of the soundings. A confirmed shoal sets the depth when
-- it's shoaler, however many deeper vessels surround it. The margin alone never makes
-- water drying: below 0 only where the median or a confirmed shoal is. Never past the
-- drying band's floor, MIN_DEPTH_M, which the overlay's bands start from.
SELECT *, CASE WHEN low IS NOT NULL THEN greatest(low, dry_floor, {MIN_DEPTH_M}) END AS depth
FROM (
  SELECT v.tile_id, v.level, v.cr, v.cc, v.r, v.c, ps.sigma,
    least(ps.depth, v.m - {statistic.K} * ps.sigma, v.shoal) AS low,
    least(0, ps.median, v.m, v.shoal) AS dry_floor
  FROM own v JOIN pixel_sigma ps
    ON ps.tile_id = v.tile_id AND ps.py = v.r // 2 AND ps.px = v.c // 2
);

CREATE OR REPLACE TEMP TABLE stats AS
-- An aggregated cell keeps its shoalest base cell, so aggregation never hides an accepted
-- shoal, and that base cell's σ.
SELECT * FROM (
  SELECT tile_id, level, cr, cc, any_value(cell_id) AS cell_id, any_value(lat0) AS lat0,
    any_value(lon0) AS lon0, any_value(k) AS k, median(d) FILTER (WHERE keep_cell) AS median,
    coalesce(mad(d) FILTER (WHERE keep_cell), 0) AS mad, min(d) AS min, max(d) AS max,
    count(*) AS count, count(DISTINCT vessel) AS vessels, min(time) AS first, max(time) AS last,
    count(*) FILTER (WHERE tided) AS tided, count(*) FILTER (WHERE calibrated) AS calibrated
  FROM accepted GROUP BY tile_id, level, cr, cc
) JOIN (
  SELECT tile_id, level, cr, cc, min(depth) AS depth, arg_min(sigma, (depth, sigma)) AS sigma
  FROM children GROUP BY ALL
) USING (tile_id, level, cr, cc);

-- SOUNDG sits at the accepted sounding nearest the cell's depth: a confirmed shoal's
-- own position when one set it.
CREATE OR REPLACE TEMP TABLE placed AS
-- A sounding at least as deep as the cell's depth comes first, so the label is never
-- deeper than what was read at its spot. Ties go to the earliest and then the least
-- point_id, not to whichever thread saw one first, so unchanged soundings always place
-- a cell's sounding in the same spot.
SELECT a.tile_id, a.level, a.cr, a.cc,
  arg_min({{'lon': a.lon, 'lat': a.lat}}, (a.d < s.depth, abs(a.d - s.depth), a.time, a.point_id))
    FILTER (WHERE a.time IS NOT NULL) AS at
FROM accepted a JOIN stats s USING (tile_id, level, cr, cc) GROUP BY ALL;
DROP TABLE accepted;
"""

CELLS = f"""
SELECT s.tile_id, s.level, s.cr AS "row", s.cc AS col,
  s.lon0 + s.cc * s.level * s.k / {BASE} AS lon_min, s.lat0 + s.cr * s.level / {BASE} AS lat_min,
  s.lon0 + (s.cc + 1) * s.level * s.k / {BASE} AS lon_max,
  s.lat0 + (s.cr + 1) * s.level / {BASE} AS lat_max,
  s.depth, s.median, s.mad, s.min, s.max, s.count, s.vessels,
  -- One vessel's cells carry only the year, so a chain of them can't date one boat's track.
  date_trunc(CASE WHEN s.vessels <= 1 THEN 'year' ELSE 'month' END, s.first)::DATE AS first,
  date_trunc(CASE WHEN s.vessels <= 1 THEN 'year' ELSE 'month' END, s.last)::DATE AS last,
  s.sigma, greatest({tolerance("s.depth")}, 1.96 * s.sigma) AS tvu,
  CASE WHEN s.vessels >= {MIN_VESSELS} THEN 'multi' ELSE 'single' END AS kind, 5 AS zoc,
  p.at.lon AS depth_lon, p.at.lat AS depth_lat, s.cell_id, {GRID_VERSION} AS grid_version,
  s.tided, s.calibrated
FROM stats s JOIN placed p USING (tile_id, level, cr, cc)
"""

CELL_FLAGS = f"""
SELECT point_id, 'reject' AS flag, 'cell_deep' AS reason FROM classed WHERE outlier = 'deep'
UNION ALL
SELECT point_id, flag, reason FROM consensus_rejects
UNION ALL
-- A shoal its cell's accepted soundings contradict, or, in a cell with none to judge it
-- against, one nobody has confirmed yet.
SELECT point_id, 'unconfirmed', CASE WHEN judged THEN 'cell_shoal' ELSE 'cell_unjudged' END
FROM classed
WHERE outlier = 'shoal' AND NOT from_track AND point_id NOT IN (SELECT point_id FROM confirmed)
UNION ALL
-- A track spike its cell agrees with.
SELECT point_id, 'confirmed', 'cell_confirmed' FROM classed
WHERE from_track AND outlier IS NULL AND raw >= {SHALLOW_M} AND NOT hunting
UNION ALL
-- A confirmed shoal, track spike or not: the surface is never drawn deeper than one. Its
-- reason is a cell's shoal, as an unconfirmed one's is, so every build clears it.
SELECT point_id, 'confirmed', 'cell_shoal' FROM classed
WHERE outlier = 'shoal' AND point_id IN (SELECT point_id FROM confirmed)
  AND NOT (from_track AND hunting)
"""


# One band's active points, with their corrections and each point's base row. Each
# band of a dense tile is read from the store once and kept, for its neighbors'
# consensus and for shoals, so the dedupe's memory follows the band. A band alone gives the same points as the
# whole tile, since dedupe only drops a sounding's twins, which share its position and
# so its row.
TILE_POINTS = f"""
SELECT point_id, tile_id, cell_id, unique_id, time, lon, lat, depth_raw, depth, tide, offset_m,
  sigma, excluded, lost_bottom, awaiting_tide, {BASE_ROW} AS r
FROM corrected_points_in($partition, $tiles, $rlo, $rhi) p
"""

# Active soundings that are still unconfirmed shoals, neither confirmed nor rejected since,
# with their base cells. A run whose sounder lost the bottom adds its soundings QC didn't reject,
# as unconfirmed shoals, where they're shallower than HAZARD_M. The soundings are the
# deduplicated ones the cells are built from, so a copy dedupe dropped can't hold a cell
# open.
SHOALS = f"""
CREATE OR REPLACE TEMP TABLE shoals AS
SELECT p.tile_id, p.r,
  least(floor((p.lon - (p.tile_id % 360 - 180)) * {BASE} / {K_LIST}[p.tile_id // 360 - 90 + 91])
    ::INTEGER, {BASE} // {K_LIST}[p.tile_id // 360 - 90 + 91] - 1) AS c,
  p.lon, p.lat, p.depth_raw, p.depth
FROM tile_points p
-- A segment too deep to correct publishes nothing, its shoals included.
WHERE NOT p.excluded AND NOT p.awaiting_tide
  -- A run whose sounder lost the bottom warns of no hazard from deeper than HAZARD_M, nor from
  -- a reading under SHALLOW_M, a sounder's junk.
  AND NOT (p.lost_bottom AND (p.depth >= {HAZARD_M} OR p.depth_raw < {SHALLOW_M}))
  AND (p.point_id IN (
  SELECT point_id FROM lake.qc_flags
  WHERE cell_id = $partition AND flag = 'unconfirmed' AND qc_version = {QC_VERSION}
  EXCEPT
  SELECT point_id FROM lake.qc_flags
  WHERE cell_id = $partition AND flag IN ('confirmed', 'reject') AND qc_version = {QC_VERSION})
  OR p.lost_bottom AND p.depth_raw > 0 AND p.depth_raw <= {MAX_DEPTH_M}
    AND p.depth >= {MIN_DEPTH_M} AND p.point_id NOT IN (
      SELECT point_id FROM lake.qc_flags
      WHERE cell_id = $partition AND flag = 'reject' AND qc_version = {QC_VERSION}))
"""


def units(con, partition: int, tiles: list[int], rows=9) -> list[tuple[list[int], int, int]]:
    """A partition's work in units of about BATCH_POINTS points: (tiles, first base row, end row).

    Small tiles are grouped whole. A denser tile is split into bands of `rows` base rows,
    by default 3″, so every cell, and the levels and outliers judged within it, falls in
    one band.
    """
    counts = con.execute(
        f"""SELECT tile_id, {BASE_ROW} // $rows AS band, count(*) AS n
        FROM lake.points p
        WHERE cell_id = $partition AND (len($tiles) = 0 OR list_contains($tiles, tile_id))
        GROUP BY ALL ORDER BY ALL""",
        {"partition": partition, "tiles": tiles, "rows": rows},
    ).fetchall()
    by_tile = {}
    for tile, band, n in counts:
        by_tile.setdefault(tile, []).append((band, n))
    result, group, size = [], [], 0
    for tile, bands in by_tile.items():
        total = sum(n for _, n in bands)
        if total <= BATCH_POINTS:
            if group and size + total > BATCH_POINTS:
                result.append((group, 0, BASE))
                group, size = [], 0
            group.append(tile)
            size += total
            continue
        start, size_band = 0, 0
        for band, n in bands:
            # ponytail: one band of `rows` over the budget still runs alone
            if size_band and size_band + n > BATCH_POINTS:
                result.append(([tile], start * rows, band * rows))
                start, size_band = band, 0
            size_band += n
        result.append(([tile], start * rows, BASE))
    if group:
        result.append((group, 0, BASE))
    return result


def inputs(con) -> str:
    """A fingerprint of what cells are built from: every file's version, content and
    status, every batch's QC version, the corrections, and the QC and grid versions of
    this build. Points and flags change only with these, so cells built from the same
    fingerprint are current; a new ETag on the same content changes none of them."""
    [(files, batches, offsets)] = con.execute(
        """SELECT
          (SELECT coalesce(sum(hash(file_id, key, version, status, content_hash)::HUGEINT), 0)
            FROM lake.files),
          (SELECT coalesce(sum(hash(batch_id, qc_version)::HUGEINT), 0) FROM lake.qc_batches),
          (SELECT coalesce(sum(hash(file_id, vessel, offset_m, se_m, excluded,
              coalesce(lost_bottom, false))::HUGEINT), 0) FROM lake.file_offsets)
          + (SELECT coalesce(sum(hash(content_hash, vessel, tile_id, t_start, t_end)::HUGEINT), 0)
            FROM lake.lost_runs)"""
    ).fetchall()
    return f"{files}:{batches}:{offsets}:{tides(con)}:{QC_VERSION}:{GRID_VERSION}"


def tides(con) -> str:
    """A fingerprint of every sounding's tide level: the levels and each cell's station."""
    [(value,)] = con.execute(
        """SELECT
          (SELECT coalesce(sum(hash(station_id, slot, level, slope, sigma)::HUGEINT), 0)
            FROM lake.tide_levels)
          || '/' || (SELECT coalesce(sum(hash(tide_cell, station_id)::HUGEINT), 0)
            FROM lake.tide_cells)"""
    ).fetchall()
    return value


def settled(con) -> bool:
    """Whether the cells are current, or would be once the tiles in `tile_changes` are
    rebuilt. Cells an older build wrote, after a rollback, never are: the marker says what
    the cells were built from, not which code built them."""
    if old_cells(con):
        return False
    now = inputs(con)
    return any(
        value == now
        for (value,) in con.execute(
            "SELECT value FROM lake.store_meta WHERE key IN ('cells', 'cells_pending')"
        ).fetchall()
    )


def stale(con, tiles_query, params, reason, was_settled):
    """Record the tiles `tiles_query` selects as stale after a correction change. If the
    cells were settled before it, rebuilding those tiles settles them again."""
    params = params | {"reason": reason, "now": datetime.now(UTC).replace(tzinfo=None)}
    [(n,)] = con.execute(
        f"""INSERT INTO lake.tile_changes
        SELECT DISTINCT tile_id, $reason, $now FROM ({tiles_query})""",
        params,
    ).fetchall()
    con.execute("DELETE FROM lake.store_meta WHERE key = 'cells_pending'")
    if was_settled:
        con.execute("INSERT INTO lake.store_meta VALUES ('cells_pending', ?)", [inputs(con)])
    return n


def old_cells(con) -> bool:
    return bool(
        con.execute(
            f"SELECT count(*) FROM lake.cells WHERE grid_version <> {GRID_VERSION}"
        ).fetchone()[0]
    )


def changed(con) -> list[int]:
    """Tiles a correction change has made stale."""
    return [
        t
        for (t,) in con.execute(
            "SELECT DISTINCT tile_id FROM lake.tile_changes ORDER BY 1"
        ).fetchall()
    ]


def done(con, tiles):
    """Clear rebuilt tiles' changes; once none are left, cells that were settled are current."""
    con.execute(
        "DELETE FROM lake.tile_changes WHERE list_contains($tiles, tile_id)", {"tiles": tiles}
    )
    if con.execute("SELECT count(*) FROM lake.tile_changes").fetchone()[0]:
        return
    pending = con.execute(
        "SELECT value FROM lake.store_meta WHERE key = 'cells_pending'"
    ).fetchone()
    con.execute("DELETE FROM lake.store_meta WHERE key = 'cells_pending'")
    if pending and pending[0] == inputs(con) and not old_cells(con):
        con.execute("DELETE FROM lake.store_meta WHERE key = 'cells'")
        con.execute("INSERT INTO lake.store_meta VALUES ('cells', ?)", pending)


def clear(con, partition, tiles):
    """Delete the tiles' cells and unconfirmed shoals."""
    params = {"partition": partition, "tiles": tiles}
    con.execute("BEGIN")
    for table in ("cells", "shoals"):
        con.execute(
            f"DELETE FROM lake.{table} WHERE cell_id = $partition AND list_contains($tiles, tile_id)",
            params,
        )
    con.execute("COMMIT")


def classify(con, partition, rlo, rhi, first):
    """Cell-level flags for one band of `tile_points`, and its accepted soundings added to
    `group_accepted`."""
    params = {"partition": partition, "rlo": rlo, "rhi": rhi}
    # Each step commits on its own, so a replaced or dropped table's space is freed
    # at once. A group's flags and cells are complete only once `build` finishes it.
    for statement in filter(str.strip, CLASSIFY.split(";\n")):
        # DuckDB refuses parameters a statement doesn't use.
        con.execute(statement, {k: v for k, v in params.items() if f"${k}" in statement})
    into = (
        "CREATE OR REPLACE TEMP TABLE group_accepted AS" if first else "INSERT INTO group_accepted"
    )
    con.execute(f"{into} SELECT * FROM accepted")
    con.execute("DROP TABLE accepted")
    con.execute(
        f"""INSERT INTO lake.qc_flags BY NAME
        SELECT q.*, $partition::SMALLINT AS cell_id, {QC_VERSION} AS qc_version
        FROM ({CELL_FLAGS}) q""",
        {"partition": partition},
    )


# Confirmed shoals the other vessels outvote: the lower median of the other vessels'
# votes (their median depths) in the shoal's pixel, or its 3x3 where the pixel has too
# few, is more than the tolerance deeper than the shoal. The lower median, so where at
# least half the other vessels read the shoal too it stands; the shoal's own vessel
# doesn't vote, so two vessels reading a rock among two deeper ones are outvoted.
OUTVOTED = f"""
CREATE OR REPLACE TEMP TABLE outvoted AS
WITH votes AS (
  SELECT tile_id, py, px, vessel, median(d) FILTER (WHERE keep_v) AS m
  FROM {
    sample(
        "(SELECT *, r // 2 AS py, c // 2 AS px FROM group_accepted)",
        ["tile_id", "py", "px", "vessel"],
        "keep_v",
    )
}
  GROUP BY ALL
),
-- Judged once per pixel and vessel, however many of its soundings are confirmed shoals.
keys AS (
  SELECT DISTINCT tile_id, r // 2 AS py, c // 2 AS px, vessel FROM group_accepted
  WHERE outlier = 'shoal'
),
reach AS (
  SELECT k.*, k.py + dy AS py2, k.px + dx AS px2, dy = 0 AND dx = 0 AS own
  FROM keys k, range(-1, 2) a(dy), range(-1, 2) b(dx)
),
-- Each other vessel votes once: its vote in the pixel, and its median vote across the
-- 3x3, so a vessel that crossed more of the neighbours counts no more.
each AS (
  SELECT r.tile_id, r.py, r.px, r.vessel, v.vessel AS other,
    any_value(v.m) FILTER (WHERE r.own) AS m1, median(v.m) AS m3
  FROM reach r JOIN votes v
    ON v.tile_id = r.tile_id AND v.py = r.py2 AND v.px = r.px2 AND v.vessel <> r.vessel
  GROUP BY ALL
),
others AS (
  SELECT tile_id, py, px, vessel, count(m1) AS n1, quantile_disc(m1, 0.5) AS m1,
    count(*) AS n3, quantile_disc(m3, 0.5) AS m3
  FROM each GROUP BY ALL
),
judged AS (
  SELECT tile_id, py, px, vessel, CASE WHEN n1 >= {SHOAL_CHECK_VESSELS} THEN m1
    WHEN n3 >= {SHOAL_CHECK_VESSELS} THEN m3 END AS m
  FROM others
)
SELECT a.point_id, a.d FROM group_accepted a JOIN judged j
  ON j.tile_id = a.tile_id AND j.py = a.r // 2 AND j.px = a.c // 2 AND j.vessel = a.vessel
WHERE a.outlier = 'shoal' AND a.d < j.m - {tolerance("j.m")};
"""


def check_shoals(con, partition):
    """Confirmed shoals the other vessels outvote are flagged as consensus disproves a
    shoal: out of the cells' depths and the surface's cap, published as unconfirmed
    soundings shallower than HAZARD_M and rejected as stray echoes deeper. The reason is
    one every build clears."""
    con.execute(OUTVOTED)
    params = {"partition": partition}
    con.execute(
        f"""DELETE FROM lake.qc_flags WHERE cell_id = $partition AND qc_version = {QC_VERSION}
        AND flag = 'confirmed' AND reason = 'cell_shoal'
        AND point_id IN (SELECT point_id FROM outvoted)""",
        params,
    )
    con.execute(
        f"""INSERT INTO lake.qc_flags BY NAME
        SELECT point_id, CASE WHEN d < {HAZARD_M} THEN 'unconfirmed' ELSE 'reject' END AS flag,
          'consensus_shoal' AS reason,
          $partition::SMALLINT AS cell_id, {QC_VERSION} AS qc_version FROM outvoted""",
        params,
    )
    con.execute("DELETE FROM group_accepted WHERE point_id IN (SELECT point_id FROM outvoted)")
    con.execute("DROP TABLE outvoted")


def sigmas(con):
    """`pixel_sigma`: σ and the statistic's depth at every 2/3″ pixel `group_accepted` has
    a vote in, tile by tile."""
    parts = []
    for (tile,) in con.execute("SELECT DISTINCT tile_id FROM group_accepted").fetchall():
        got = con.execute(ENTRIES, {"tile": tile}).fetchnumpy()
        px, py = (np.asarray(got[c], dtype=np.int64) for c in ("px", "py"))
        m, s = (np.asarray(got[c], dtype=np.float64) for c in ("m", "s"))
        # Each vessel smoothed along its own coverage, as the surface's are.
        px, py, m, s = statistic.smoothed(px, py, np.asarray(got["v"], dtype=np.uint64), m, s)
        upx, upy, median, spread, csig = statistic.sigma_b(px, py, m, s)
        sigma = statistic.sigma_at(upx, upy, spread, csig)(upx, upy)
        parts.append(
            (np.full(len(upx), tile), upy, upx, sigma, median - statistic.K * sigma, median)
        )
    columns = [np.concatenate(c) for c in zip(*parts)] if parts else [np.empty(0)] * 6
    names = ("tile_id", "py", "px", "sigma", "depth", "median")
    con.register("pixel_sigma", dict(zip(names, columns)))


def measure(con, rlo, rhi):
    """Measured cells for one band of `group_accepted`; returns how many."""
    params = {"rlo": rlo, "rhi": rhi}
    for statement in filter(str.strip, STATS.split(";\n")):
        con.execute(statement, {k: v for k, v in params.items() if f"${k}" in statement})
    con.execute("BEGIN")
    [(inserted,)] = con.execute(
        f"""INSERT INTO lake.cells BY NAME
        SELECT * FROM ({CELLS}) ORDER BY tile_id, level, "row", col"""
    ).fetchall()
    con.execute("COMMIT")
    return inserted


# Each of the tiles' cells, summed: whether a tile's cells are still the ones a build
# wrote. A tile with no cells has no row.
DIGESTS = """
SELECT tile_id, count(*) || ':' || sum(hash(level, "row", col, depth, median, mad, min, max,
  count, vessels, kind, first, last, tvu, sigma, depth_lon, depth_lat, grid_version)::HUGEINT) AS digest
FROM lake.cells WHERE ($partition IS NULL OR cell_id = $partition) AND list_contains($tiles, tile_id)
GROUP BY tile_id
"""

# The code that builds cells, the QC they read and their definitions: a build resumes
# only work this same code did, since cell logic can change without a GRID_VERSION bump.
# The cells read corrected depths through catalog's macros, so its code counts too.
CODE = hashlib.sha256(
    b"".join(
        Path(f).read_bytes()
        for f in (
            __file__,
            qc.__file__,
            catalog.__file__,
            statistic.__file__,
            Path(definitions.__file__).with_suffix(".json"),
        )
    )
).hexdigest()[:16]


def build(con, tiles: list[int] | None = None) -> dict:
    """Rebuild cells, cell-level QC flags and unconfirmed shoals for the given tiles, or
    every tile with points.

    Tiles are read once, and a dense tile's bands are worked from that read: each band
    classified, then σ from every band's accepted soundings, so a band's edge gets the same
    σ as its middle, then each band's cells.
    """
    if tiles is not None and not tiles:
        raise ValueError("no tiles to build; None builds every tile")
    tiles = tiles or []
    # Only a build of every tile can say the cells are current, and only once it has
    # finished: the marker goes first, so a build that stops partway leaves none. A tile
    # group a build finished from these same inputs before it stopped is kept, while its
    # cells are still the ones that build wrote: an older build, which knows nothing of
    # cells_built, may have rebuilt or cleared them since. It must also be this same
    # code. A build that finishes clears its tiles' rows, so a later build of unchanged
    # inputs rebuilds.
    built_from = inputs(con)
    resume_key = f"{built_from}:{CODE}"
    stopped = {
        t: digest
        for t, digest in con.execute(
            """SELECT tile_id, digest FROM lake.cells_built WHERE inputs = $key
            AND (len($tiles) = 0 OR list_contains($tiles, tile_id))""",
            {"key": resume_key, "tiles": tiles},
        ).fetchall()
    }
    # Digests only for what a stopped build left, so a fresh build reads no cells here.
    current = (
        dict(con.execute(DIGESTS, {"partition": None, "tiles": list(stopped)}).fetchall())
        if stopped
        else {}
    )
    done = {t for t, digest in stopped.items() if current.get(t, "0:0") == digest}
    con.execute("DELETE FROM lake.store_meta WHERE key = 'cells'")
    partitions = [
        p
        for (p,) in con.execute(
            """SELECT DISTINCT cell_id FROM lake.points
            WHERE len($tiles) = 0 OR list_contains($tiles, tile_id) ORDER BY 1""",
            {"tiles": tiles},
        ).fetchall()
    ]
    work = [(p, *unit) for p in partitions for unit in units(con, p, tiles)]
    totals = {"units": len(work), "cells": 0, "kept": 0}
    # Each band's points are read from the store once and kept for the group, and its
    # shoals found once from the flags, rather than per band with overlaps. A build
    # publishes only between groups, so the store is never seen with some of a group's
    # bands rebuilt and not others: each group's cells, flags and shoals are complete.
    for (partition, unit_tiles), group in itertools.groupby(work, key=lambda w: w[:2]):
        bands = [(rlo, rhi) for *_, rlo, rhi in group]
        if set(unit_tiles) <= done:
            totals["kept"] += len(bands)
            continue
        clear(con, partition, unit_tiles)
        for i, (rlo, rhi) in enumerate(bands):
            params = {"partition": partition, "tiles": unit_tiles, "rlo": rlo, "rhi": rhi}
            into = "INSERT INTO tile_points" if i else "CREATE OR REPLACE TEMP TABLE tile_points AS"
            con.execute(f"{into} {TILE_POINTS}", params)
            # Every point's old cell-level flags, active or not.
            con.execute(
                f"""DELETE FROM lake.qc_flags WHERE cell_id = $partition
                AND qc_version = {QC_VERSION} AND list_contains({CELL_REASONS}, reason)
                AND point_id IN (
                  SELECT point_id FROM lake.points p
                  WHERE cell_id = $partition AND list_contains($tiles, tile_id)
                    AND {BASE_ROW} BETWEEN $rlo AND $rhi - 1)""",
                params,
            )
        # Flags band by band, then σ from every band's votes, then each band's cells.
        for i, (rlo, rhi) in enumerate(bands):
            classify(con, partition, rlo, rhi, first=not i)
        check_shoals(con, partition)
        sigmas(con)
        for rlo, rhi in bands:
            totals["cells"] += measure(con, rlo, rhi)
        con.unregister("pixel_sigma")
        con.execute("DROP TABLE group_accepted")
        # Shoals follow every band's flags.
        con.execute(SHOALS, {"partition": partition})
        con.execute(
            f"""INSERT INTO lake.shoals
            SELECT tile_id, r, lon, lat, depth, $partition FROM shoals
            WHERE depth_raw > 0 AND depth_raw <= {MAX_DEPTH_M} AND depth >= {MIN_DEPTH_M}
            ORDER BY tile_id, r, lon""",
            {"partition": partition},
        )
        con.execute("DROP TABLE tile_points")
        con.execute("BEGIN")
        con.execute(
            "DELETE FROM lake.cells_built WHERE list_contains($tiles, tile_id)",
            {"tiles": unit_tiles},
        )
        con.execute(
            f"""INSERT INTO lake.cells_built
            SELECT t.tile_id, $key, coalesce(d.digest, '0:0')
            FROM (SELECT unnest($tiles) AS tile_id) t LEFT JOIN ({DIGESTS}) d USING (tile_id)""",
            {"tiles": unit_tiles, "key": resume_key, "partition": partition},
        )
        con.execute("COMMIT")
        checkpoint(con)
    log.info("cells: %s", totals)
    con.execute("BEGIN")
    con.execute(
        "DELETE FROM lake.cells_built WHERE len($tiles) = 0 OR list_contains($tiles, tile_id)",
        {"tiles": tiles},
    )
    if not tiles:
        # Every tile is rebuilt, so nothing a correction marked is stale any more.
        con.execute("DELETE FROM lake.tile_changes")
        con.execute("DELETE FROM lake.store_meta WHERE key = 'cells_pending'")
        con.execute("INSERT INTO lake.store_meta VALUES ('cells', ?)", [built_from])
    con.execute("COMMIT")
    return totals
