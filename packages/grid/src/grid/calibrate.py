"""Vessel calibration: a vertical offset per vessel step segment, from surveys and crossings.

A vessel's depths differ from the truth by its transducer depth, offsets its logger
applies and the sound speed its sounder assumes, which change when a sounder is moved,
replaced or reconfigured. Each segment of a vessel's history between such steps gets
one offset (negative reads shallow) and its standard error, solved jointly:

- Anchors: a surveyed reference (BlueTopo, S-102) on flat, shallow-to-moderate seabed
  anchors a segment with at least ANCHOR_PIXELS pixels across ANCHOR_TRANSITS
  transits, weighted by its standard error rather than fixed, so one bad anchor can't
  pull its neighbors.
- Crossings: wherever two units sounded the same 2/3″ pixel, `depth = pixel depth +
  offset`, with pixel depths eliminated, so each pixel adds terms between its units
  alone. Each tile adds its pixels' terms to one sparse system with an unknown per
  unit, and Huber weights by iteratively reweighted least squares absorb position
  error on slopes. A transit's pixels share its tide and squat, so each transit weighs
  as one observation however many pixels it crosses.

Depths are tide-reduced first, which cuts the spread of per-transit offsets by about
a quarter. The unit of comparison is a vessel's median per file (transit) per pixel,
so a vessel logging at 1 Hz doesn't outweigh one logging every few seconds.

Steps are found on each vessel's per-transit offsets, against the reference and
against the other vessels' pixel depths from a first solve with one unit per vessel,
by binary segmentation. The second solve has one unit per segment. A segment without
an anchor counts as calibrated from CROSSING_TRANSITS crossing transits, when its
crossings link it to an anchored one. Only calibrated offsets are applied, and only plausible ones
(OFFSET_RANGE_M, MAX_SE_M): an uncalibrated vessel reads as it was logged, usually shoal,
which errs safe, while a wrong negative offset would deepen every sounding it corrects.
Anything known to read deep that isn't corrected is left out (see `assign`).

No depth scale factor is fitted: at 2–20 m it barely narrows the spread.
"""

import bisect
import hashlib
import inspect
import logging
import math

import numpy as np
from scipy.sparse import coo_matrix, csc_matrix, csr_matrix, diags
from scipy.sparse.csgraph import connected_components
from scipy.sparse.linalg import splu

from . import cells, reference
from .cells import BASE, K_LIST
from .qc import QC_VERSION, TRACK_REASONS

log = logging.getLogger(__name__)

MAX_DEPTH_M = 200
# Flat, well-surveyed seabed at shallow-to-moderate depth, where a small position
# error doesn't change the depth, as NOAA's CSB tool and the Chesapeake spike chose it.
ANCHOR_DEPTH_M = (2, 20)
ANCHOR_UNCERTAINTY_M = 2
ANCHOR_RELIEF_M = 0.5
ANCHOR_DIFF_M = 12
ANCHOR_PIXELS = 50
ANCHOR_TRANSITS = 2
CROSSING_TRANSITS = 5
# The spread of one transit's offset about its segment's, tide-reduced: weights a
# crossing transit against an anchor's standard error.
TRANSIT_SIGMA_M = 0.25
HUBER = 1.345
ITERATIONS = 15
# A step: medians either side differ by more than this and STEP_SE standard errors,
# with STEP_TRANSITS transits each side, each with STEP_PIXELS pixels to judge it by.
STEP_M = 0.3
STEP_SE = 4
STEP_TRANSITS = 5
STEP_PIXELS = 10
SE_FLOOR_M = 0.02
# Offsets applied: from about the deepest ship's transducer (vessels read as much as 9 m
# shallow in the Chesapeake) to a little deep, and known to within half a metre.
OFFSET_RANGE_M = (-10.0, 3.0)
MAX_SE_M = 0.5
APPLIED = ("anchored", "crossover")
# A file reading deeper than this, known but not corrected, is left out of the grid.
DEEP_M = 0.5
# A sounder that has lost the bottom holds a narrow band of readings, wandering a step or
# two of its resolution, for minutes to hours: on the Chesapeake 0.3 to 0.6 m or 2.4 to
# 3.0 m, for up to 15 km, over seabed 7 to 25 m deep. A reading is lost where it's under
# LOST_BOTTOM of what its segment reads over the seabed there, and LOST_MARGIN_M under it,
# so a depth that is merely small isn't judged by a ratio. A window of STUCK_WINDOW
# readings is stuck where STUCK_LOST of them read lost and the middle 80% of them span no
# more than STUCK_SPAN_M, so the band's edges and a reading near the line don't break it.
# A run counts from STUCK_RUN stuck windows across STUCK_REACH_M: a boat at its mooring,
# reading a slip shallower than the survey's pixel around it, goes nowhere.
STUCK_WINDOW = 30
STUCK_LOST = 27
STUCK_SPAN_M = 0.4
LOST_BOTTOM = 0.5
LOST_MARGIN_M = 2.0
STUCK_RUN = 60
STUCK_REACH_M = 200
# The seabed a run is judged over: the survey's, or the median of the corrected depths of
# at least CROWD_VESSELS vessels, whichever is shallower, so water that has shoaled since
# the survey isn't mistaken for a lost bottom. Against the survey on the Chesapeake, three
# vessels found 96% of the soundings it did, at 98% precision.
CROWD_VESSELS = 3
# A vessel's calendar month with MONTH_SHARE or more of its pixels reading lost (from
# MONTH_PIXELS judged) is set aside whole: on the Chesapeake 14 months of 7 vessels, a
# fifth of the stuck readings, at 61,000 good pixels. A vessel with any month at
# STUCK_SHARE or more has its stuck runs found too; the others aren't searched.
MONTH_SHARE = 0.2
STUCK_SHARE = 0.05
MONTH_PIXELS = 100
# Of a store's calibrated segments, more than this share lost in one run is refused.
MAX_LOST = 0.5
GUARDED_SEGMENTS = 20

# Each vessel's median tide-reduced depth per file per calibration pixel (two base rows
# by two base columns), from soundings track QC accepted. Read a unit of tiles or a band
# of one at a time, whose rows hold whole pixels.
REDUCE = f"""
INSERT INTO cal_obs
SELECT p.tile_id, floor((p.lat - (p.tile_id // 360 - 90)) * {BASE} / 2)::INTEGER AS py,
  floor((p.lon - (p.tile_id % 360 - 180)) * {BASE}
    / {K_LIST}[p.tile_id // 360 - 90 + 91] / 2)::INTEGER AS px,
  p.unique_id AS vessel, p.file_id, min(p.time) AS t,
  median(p.depth_raw - coalesce(p.tide, 0))::FLOAT AS m
FROM corrected_points_in($partition, $tiles, $rlo, $rhi) p
WHERE p.depth_raw > 0 AND p.depth_raw <= {MAX_DEPTH_M} AND p.time IS NOT NULL
  -- Tide-reduced, or where `grid tide` found no station in reach: one whose level is
  -- still to come, or in a cell tide hasn't seen, would leave the tide in the offset and
  -- count it twice once the level arrives.
  AND (p.tide IS NOT NULL OR (p.tide_assigned AND p.tide_station IS NULL))
  AND p.point_id NOT IN (
    SELECT point_id FROM lake.qc_flags WHERE cell_id = $partition AND list_contains($tiles, tile_id)
      AND qc_version = {QC_VERSION} AND list_contains({TRACK_REASONS}, reason)
      AND flag IN ('reject', 'unconfirmed', 'noisy'))
GROUP BY ALL
"""

# Rows at anchor-quality reference pixels (`anchor_px`), with the difference from the
# reference.
ANCHOR_ROWS = f"""
SELECT o.vessel, o.file_id, o.t, o.tile_id, o.py, o.px, o.m - r.depth AS e, r.depth AS z
FROM cal_obs o JOIN anchor_px r USING (tile_id, py, px)
WHERE abs(o.m - r.depth) < {ANCHOR_DIFF_M}
"""

# Stuck runs in one tile, for the vessels in `$vessels`: each file's soundings in order
# (ties broken by row, so a run comes out the same every time), its stuck windows
# (`unit_offsets`, `seabed_px`) joined where they overlap; a run counts from STUCK_RUN
# stuck windows across STUCK_REACH_M, and starts and ends on a lost reading, so a bank
# crossed just before the sounder sticks at its depth isn't in it.
STUCK = f"""
WITH p AS (
  SELECT p.file_id, p.row, p.unique_id AS vessel, p.time, p.lon, p.lat, p.depth_raw AS raw,
    p.depth_raw - coalesce(p.tide, 0) AS tr,
    floor((p.lat - (p.tile_id // 360 - 90)) * {BASE} / 2)::INTEGER AS py,
    floor((p.lon - (p.tile_id % 360 - 180)) * {BASE}
      / {K_LIST}[p.tile_id // 360 - 90 + 91] / 2)::INTEGER AS px
  FROM corrected_points_in($partition, [$tile], 0, {BASE}, vessels := $vessels) p
  WHERE p.depth_raw > 0 AND p.depth_raw <= {MAX_DEPTH_M} AND p.time IS NOT NULL
    AND (p.tide IS NOT NULL OR (p.tide_assigned AND p.tide_station IS NULL))
    AND p.point_id NOT IN (
      SELECT point_id FROM lake.qc_flags WHERE cell_id = $partition AND tile_id = $tile
        AND qc_version = {QC_VERSION} AND list_contains({TRACK_REASONS}, reason)
        AND flag IN ('reject', 'unconfirmed', 'noisy')
        -- A held depth is what a stuck sounder reads: in, or the run breaks around it.
        AND NOT (flag = 'unconfirmed' AND reason = 'flatline'))
),
w AS (
  SELECT p.*,
    coalesce(tr < {LOST_BOTTOM} * (u.o + s.z) AND tr < u.o + s.z - {LOST_MARGIN_M}, false) AS lost,
    row_number() OVER (PARTITION BY p.file_id ORDER BY time, raw, row) AS i
  FROM p JOIN unit_offsets u USING (vessel, file_id)
  LEFT JOIN seabed_px s ON s.tile_id = $tile AND s.py = p.py AND s.px = p.px
),
x AS (
  -- Stuck: STUCK_LOST of the STUCK_WINDOW soundings up to it read lost, and their middle
  -- 80% span no more than STUCK_SPAN_M.
  SELECT *, count(*) OVER win = {STUCK_WINDOW} AND sum(lost::INTEGER) OVER win >= {STUCK_LOST}
      AND quantile_cont(raw, 0.9) OVER win - quantile_cont(raw, 0.1) OVER win <= {STUCK_SPAN_M}
      AS stuck
  FROM w WINDOW win AS (PARTITION BY file_id ORDER BY time, raw, row
    ROWS BETWEEN {STUCK_WINDOW - 1} PRECEDING AND CURRENT ROW)
),
m AS (
  -- Every sounding of a stuck window, and no other: a boat's approach to its mooring, or
  -- real depths around a flat stretch, stay out.
  SELECT *, bool_or(stuck) OVER (PARTITION BY file_id ORDER BY time, raw, row
      ROWS BETWEEN CURRENT ROW AND {STUCK_WINDOW - 1} FOLLOWING) AS member
  FROM x
),
l AS (
  SELECT *, i - row_number() OVER (PARTITION BY file_id ORDER BY time, raw, row) AS run
  FROM m WHERE member
)
-- From its first lost reading to its last, so a true one before or after stays out.
SELECT f.content_hash, l.vessel, $tile AS tile_id, min(l.time) FILTER (WHERE l.lost) AS t_start,
  max(l.time) FILTER (WHERE l.lost) AS t_end
FROM l JOIN lake.files f USING (file_id)
GROUP BY f.content_hash, l.vessel, l.file_id, l.run
HAVING count(*) FILTER (WHERE l.stuck) >= {STUCK_RUN} AND 6371000 * sqrt(
  pow(radians(max(l.lat) FILTER (WHERE l.lost) - min(l.lat) FILTER (WHERE l.lost)), 2)
  + pow(radians(max(l.lon) FILTER (WHERE l.lost) - min(l.lon) FILTER (WHERE l.lost))
    * cos(radians(avg(l.lat))), 2)) >= {STUCK_REACH_M}
"""


def reduce(con):
    """Fill the temp table `cal_obs` in cells' units of work, so memory follows a unit
    rather than the densest tile. Returns how many tiles it read."""
    con.execute(
        """CREATE OR REPLACE TEMP TABLE cal_obs (tile_id INTEGER, py INTEGER, px INTEGER,
        vessel VARCHAR, file_id BIGINT, t TIMESTAMP, m FLOAT)"""
    )
    partitions = [
        p for (p,) in con.execute("SELECT DISTINCT cell_id FROM lake.points ORDER BY 1").fetchall()
    ]
    tiles = set()
    for partition in partitions:
        # Bands of 18 base rows: an even number, so no pixel is split between two.
        for unit, rlo, rhi in cells.units(con, partition, [], rows=18):
            con.execute(REDUCE, {"partition": partition, "tiles": unit, "rlo": rlo, "rhi": rhi})
            tiles.update(unit)
    return len(tiles)


def reference_px(con):
    """The temp tables `anchor_px`, the reference that would anchor at each pixel, and
    `survey_px`, the depth of each pixel a reference has one for: at each pixel, the
    reference with the least uncertainty there. Picked once per run and a tile at a time,
    so memory follows a tile's reference pixels rather than every one."""
    best = "QUALIFY row_number() OVER (PARTITION BY py, px ORDER BY uncertainty, source) = 1"
    con.execute(
        """CREATE OR REPLACE TEMP TABLE anchor_px (tile_id INTEGER, py INTEGER, px INTEGER,
        depth FLOAT)"""
    )
    con.execute("CREATE OR REPLACE TEMP TABLE survey_px AS FROM anchor_px LIMIT 0")
    # Only tiles calibration has medians in: no other pixel is joined.
    tiles = con.execute("SELECT DISTINCT tile_id FROM cal_obs ORDER BY 1").fetchall()
    for (tile,) in tiles:
        con.execute(
            f"""INSERT INTO anchor_px
            -- Among the references that would anchor here, so one that wouldn't can't hide
            -- one that would.
            SELECT tile_id, py, px, depth FROM lake.reference_pixels
            WHERE tile_id = $tile AND depth BETWEEN {ANCHOR_DEPTH_M[0]} AND {ANCHOR_DEPTH_M[1]}
              AND uncertainty < {ANCHOR_UNCERTAINTY_M} AND relief < {ANCHOR_RELIEF_M}
            {best}""",
            {"tile": tile},
        )
        con.execute(
            f"""INSERT INTO survey_px SELECT tile_id, py, px, depth FROM lake.reference_pixels
            WHERE tile_id = $tile AND depth IS NOT NULL {best}""",
            {"tile": tile},
        )


def stuck_runs(con, offset, status):
    """Runs of soundings whose sounder lost the bottom, as rows (content hash, vessel, tile,
    start, end): every file of a month set aside, with no tile, and the stuck runs of the
    vessels with a month at STUCK_SHARE. From segments whose offset is applied: only those
    say what a vessel should read."""
    applied = np.isin(status, APPLIED)
    con.register("offsets_np", {"unit": np.flatnonzero(applied), "o": np.asarray(offset)[applied]})
    con.execute(
        """CREATE OR REPLACE TEMP TABLE unit_offsets AS
        SELECT u.vessel, u.file_id, o.o FROM file_units u JOIN offsets_np o USING (unit)"""
    )
    con.unregister("offsets_np")
    con.execute(
        f"""CREATE OR REPLACE TEMP TABLE seabed_px AS
        WITH crowd AS (
          SELECT tile_id, py, px, median(z) AS z FROM (
            SELECT o.tile_id, o.py, o.px, o.vessel, median(o.m - u.o) AS z
            FROM cal_obs o JOIN unit_offsets u USING (vessel, file_id) GROUP BY ALL)
          GROUP BY ALL HAVING count(*) >= {CROWD_VESSELS}
        )
        -- least() passes over a NULL: either alone, or the shallower of both.
        SELECT tile_id, py, px, least(s.depth, c.z) AS z
        FROM survey_px s FULL JOIN crowd c USING (tile_id, py, px)"""
    )
    # Each vessel's calendar months: the share of its file-pixel medians reading lost.
    con.execute(
        f"""CREATE OR REPLACE TEMP TABLE vessel_months AS
        SELECT o.vessel, date_trunc('month', o.t) AS month, count(*) AS judged,
          avg((o.m < {LOST_BOTTOM} * (s.z + u.o) AND o.m < s.z + u.o - {LOST_MARGIN_M})::INTEGER)
            AS lost_share
        FROM cal_obs o JOIN unit_offsets u USING (vessel, file_id)
        JOIN seabed_px s USING (tile_id, py, px)
        GROUP BY ALL HAVING count(*) >= {MONTH_PIXELS}"""
    )
    con.execute(
        f"""CREATE OR REPLACE TEMP TABLE stuck_vessels AS
        SELECT DISTINCT vessel FROM vessel_months WHERE lost_share >= {STUCK_SHARE}"""
    )
    # A month set aside whole: each of its judged files, in every tile.
    runs = con.execute(
        f"""SELECT DISTINCT f.content_hash, f.vessel, NULL::INTEGER, f.time_min, f.time_max
        FROM cal_obs o JOIN unit_offsets USING (vessel, file_id) JOIN vessel_months m
          ON m.vessel = o.vessel AND m.month = date_trunc('month', o.t)
        JOIN lake.files f ON f.file_id = o.file_id
        WHERE f.status = 'active' AND m.lost_share >= {MONTH_SHARE}"""
    ).fetchall()
    # ponytail: a file's run is found and applied per tile, so one that crosses a tile edge
    # is two; judge across tiles if the seams show
    # One vessel of one tile at a time, so memory follows the largest vessel's soundings in a
    # tile rather than every searched vessel's. ponytail: one vessel's years at its mooring
    # still go in at once; band by file time if a liveaboard outgrows the limit
    for partition, tile, vessel in stuck_pairs(con):
        runs += con.execute(
            STUCK, {"partition": partition, "tile": tile, "vessels": [vessel]}
        ).fetchall()
    return runs


def stuck_pairs(con):
    """(partition, tile, vessel) for each vessel in `stuck_vessels` with soundings in a tile
    any of them has medians in: a vessel whose soundings in a tile are all held depths has
    none of its own there, and is searched all the same."""
    return con.execute(
        """SELECT DISTINCT cell_id, tile_id, unique_id FROM lake.points
        WHERE unique_id IN (SELECT vessel FROM stuck_vessels)
          AND tile_id IN (SELECT tile_id FROM cal_obs
            WHERE vessel IN (SELECT vessel FROM stuck_vessels))
        ORDER BY ALL"""
    ).fetchall()


def units_for(con, segments):
    """The temp table `file_units`: each vessel file's unit, by its segments' start times.

    `segments` is {vessel: [start times after the first]}; a vessel without steps is one
    unit. A file falls in a segment by its first sounding's time, as `publish` assigns it.
    """
    files = con.execute(
        """SELECT o.vessel, o.file_id, f.time_min
        FROM (SELECT DISTINCT vessel, file_id FROM cal_obs) o JOIN lake.files f USING (file_id)
        ORDER BY f.time_min, o.file_id"""
    ).fetchall()
    names, index, rows = [], {}, []
    for vessel, file_id, t in files:
        seg = bisect.bisect_right(segments.get(vessel, []), t)
        key = (vessel, seg)
        if key not in index:
            index[key] = len(names)
            names.append(key)
        rows.append((vessel, file_id, index[key]))
    con.execute(
        "CREATE OR REPLACE TEMP TABLE file_units (vessel VARCHAR, file_id BIGINT, unit INTEGER)"
    )
    if rows:
        v, f, u = zip(*rows)
        arrays = {"vessel": np.array(v), "file_id": np.array(f), "unit": np.array(u)}
        con.register("units_np", arrays)
        con.execute("INSERT INTO file_units SELECT * FROM units_np")
        con.unregister("units_np")
    return names


def crossings(con):
    """The temp table `xrows`: each unit's median at pixels two or more units share,
    weighted so each transit counts once across its crossing pixels."""
    con.execute(
        """CREATE OR REPLACE TEMP TABLE xobs AS
        WITH o AS (SELECT o.*, u.unit FROM cal_obs o JOIN file_units u USING (vessel, file_id)),
        shared AS (SELECT tile_id, py, px FROM o GROUP BY ALL HAVING count(DISTINCT unit) >= 2)
        SELECT o.* FROM o JOIN shared USING (tile_id, py, px)"""
    )
    con.execute(
        """CREATE OR REPLACE TEMP TABLE xrows AS
        WITH n AS (SELECT vessel, file_id, count(*) AS n FROM xobs GROUP BY ALL)
        SELECT tile_id, py, px, unit, median(m) AS m, sum(1.0 / n.n) AS b
        FROM xobs JOIN n USING (vessel, file_id) GROUP BY ALL ORDER BY tile_id"""
    )


def anchors(con, n_units):
    """Each unit's anchor offset and standard error, NaN where it has no anchor, and its
    anchor pixels and transits."""
    rows = con.execute(
        f"""WITH a AS (
          SELECT a.*, u.unit FROM ({ANCHOR_ROWS}) a JOIN file_units u USING (vessel, file_id)
        ),
        f AS (SELECT unit, file_id, median(e) AS e FROM a GROUP BY ALL),
        g AS (SELECT unit, count(DISTINCT (tile_id, py, px)) AS pixels FROM a GROUP BY unit)
        -- The median of the transits' medians: one long transit counts once.
        SELECT unit, median(f.e) AS offset, count(*) AS transits, g.pixels,
          list(f.e) AS per_transit
        FROM g JOIN f USING (unit) GROUP BY ALL"""
    ).fetchall()
    offset = np.full(n_units, np.nan)
    se = np.full(n_units, np.nan)
    pixels = np.zeros(n_units, int)
    transits = np.zeros(n_units, int)
    for unit, off, nt, npx, per_transit in rows:
        pixels[unit], transits[unit] = npx, nt
        if npx >= ANCHOR_PIXELS and nt >= ANCHOR_TRANSITS:
            offset[unit] = off
            se[unit] = standard_error(np.array(per_transit))
    return offset, se, pixels, transits


def standard_error(x):
    """Standard error of the median of `x`. The spread is the mean absolute deviation
    from the median, not its median, which ignores up to half the values: a split that
    leaves another segment's transits on one side must show in its standard error."""
    x = np.asarray(x, float)
    sigma = 1.2533 * np.mean(np.abs(x - np.median(x)))
    return max(1.2533 * sigma / math.sqrt(len(x)), SE_FLOOR_M)


def solve(con, n_units, anchor, anchor_se):
    """Offsets, standard errors and IRLS weights' scale for every unit.

    Each iteration is one pass over the tiles, adding each tile's pixel terms to the
    unit system, then one sparse solve. Returns (offset, se, anchored component mask).
    """
    has = ~np.isnan(anchor)
    prior = np.where(has, 1 / np.where(has, anchor_se, 1) ** 2, 0)
    tiles = [t for (t,) in con.execute("SELECT DISTINCT tile_id FROM xrows ORDER BY 1").fetchall()]
    o = np.where(has, anchor, 0.0)
    scale = TRANSIT_SIGMA_M
    for it in range(ITERATIONS):
        terms = []
        rhs = np.zeros(n_units)
        hist = np.zeros(4000)
        for tile in tiles:
            p, u, m, b = tile_rows(con, tile)
            r = residuals(p, u, m, b, o)
            hist += np.histogram(np.abs(r), bins=4000, range=(0, 20))[0]
            w = b * np.minimum(1, HUBER * scale / np.maximum(np.abs(r), 1e-9)) / TRANSIT_SIGMA_M**2
            n, y = pixel_terms(p, u, m, w, n_units)
            terms.append(n.tocoo())
            rhs += y
        # The robust spread of row residuals sets where Huber weights start to fall.
        if hist.sum():
            half = np.searchsorted(np.cumsum(hist), hist.sum() / 2)
            scale = max(1.4826 * (half + 0.5) * 20 / 4000, 0.05)
        # Every tile's terms summed at once, rather than copying the sum per tile.
        rows = np.concatenate([t.row for t in terms] + [np.arange(n_units)])
        cols = np.concatenate([t.col for t in terms] + [np.arange(n_units)])
        vals = np.concatenate([t.data for t in terms] + [prior])
        system = coo_matrix((vals, (rows, cols)), shape=(n_units, n_units)).tocsc()
        anchored = reaches(system, has)
        # A unit no anchor reaches has no absolute offset; a small ridge keeps the
        # system solvable, and it's marked uncalibrated.
        system = system + diags(np.where(anchored, 0, 1e-6))
        lu = splu(csc_matrix(system))
        new = lu.solve(rhs + prior * np.nan_to_num(anchor))
        done = it and np.max(np.abs(new - o), initial=0) < 1e-4
        o = new
        if done:
            break
    return o, np.sqrt(inverse_diagonal(lu, n_units)), anchored


def tile_rows(con, tile):
    a = con.execute("SELECT py, px, unit, m, b FROM xrows WHERE tile_id = ?", [tile]).fetchnumpy()
    _, p = np.unique(np.column_stack([a["py"], a["px"]]), axis=0, return_inverse=True)
    return p.ravel(), a["unit"].astype(np.int64), a["m"].astype(float), a["b"].astype(float)


def residuals(p, u, m, w, o):
    """Each row's residual from its pixel's depth, the weighted mean of the pixel's
    offset-corrected medians."""
    z = np.bincount(p, w * (m - o[u])) / np.bincount(p, w)
    return m - z[p] - o[u]


def pixel_terms(p, u, m, w, n_units):
    """One tile's normal equations in the unit offsets, with its pixel depths eliminated."""
    wp = np.bincount(p, w)
    b = csr_matrix((w, (p, u)), shape=(len(wp), n_units))
    normal = diags(np.bincount(u, w, n_units)) - b.T @ diags(1 / wp) @ b
    rhs = np.bincount(u, w * m, n_units) - b.T @ (np.bincount(p, w * m) / wp)
    return normal, rhs


def reaches(system, has):
    """Units joined to an anchored one through crossings."""
    _, label = connected_components(system, directed=False)
    return np.isin(label, label[has])


def inverse_diagonal(lu, n, batch=256):
    """The diagonal of the solved system's inverse: each offset's variance."""
    out = np.empty(n)
    for i in range(0, n, batch):
        j = np.arange(i, min(i + batch, n))
        e = np.zeros((n, len(j)))
        e[j, np.arange(len(j))] = 1
        out[j] = lu.solve(e)[j, np.arange(len(j))]
    return out


def transit_offsets(con, offset):
    """Each transit's offset, as rows (vessel, file_id, start, offset, seabed depth) in time
    order: against the reference where it has one, elsewhere against the pixel depths of
    the units other than its own, which are also the seabed it's judged over."""
    con.register("offsets_np", {"unit": np.arange(len(offset)), "o": offset})
    rows = con.execute(
        f"""WITH x AS (SELECT x.*, o.o FROM xrows x JOIN offsets_np o USING (unit)),
        px AS (
          SELECT tile_id, py, px, sum(b * (m - o)) AS t, sum(b) AS w FROM x GROUP BY ALL
        ),
        others AS (
          -- Each unit's pixel depth from the other units there.
          SELECT x.tile_id, x.py, x.px, x.unit, (px.t - x.b * (x.m - x.o)) / (px.w - x.b) AS z
          FROM x JOIN px USING (tile_id, py, px) WHERE px.w > x.b
        ),
        e AS (
          SELECT o.vessel, o.file_id, o.t, o.m - z.z AS e, z.z AS z
          FROM xobs o JOIN others z USING (tile_id, py, px, unit)
          UNION ALL BY NAME {ANCHOR_ROWS}
        )
        SELECT e.vessel, e.file_id, f.time_min AS t, median(e) AS e, median(z) AS z
        FROM e JOIN lake.files f USING (file_id) GROUP BY ALL
        HAVING count(*) >= {STEP_PIXELS} ORDER BY e.vessel, t, e.file_id"""
    ).fetchall()
    con.unregister("offsets_np")
    return rows


def series(rows):
    """{vessel: ([start times], [offsets])} from transit_offsets' rows."""
    out = {}
    for vessel, _, t, e, _ in rows:
        out.setdefault(vessel, ([], []))
        out[vessel][0].append(t)
        out[vessel][1].append(e)
    return out


def outliers(con, rows, offset, se, anchored):
    """Transits that disagree with their segment by more than a step: a step with too
    few transits on one side to be found. They don't take the segment's offset, which
    would correct them by another sounder's error, and are left uncalibrated. Returns
    rows (file_id, vessel, transit offset, segment offset, content hash, seabed depth), the
    hash so another file holding the same soundings, as ingest moves them on a takeover,
    keeps the exemption."""
    unit_of = {(v, f): u for v, f, u in con.execute("SELECT * FROM file_units").fetchall()}
    hashes = dict(con.execute("SELECT file_id, content_hash FROM lake.files").fetchall())
    out = []
    for vessel, file_id, _, e, z in rows:
        u = unit_of.get((vessel, file_id))
        # A unit no survey reaches has an offset about an arbitrary zero: nothing to judge by.
        if u is None or np.isnan(offset[u]) or not anchored[u]:
            continue
        d = abs(e - offset[u])
        if d > STEP_M and d > STEP_SE * math.hypot(se[u], TRANSIT_SIGMA_M):
            # The seabed it was judged over, for assign's lost-bottom test.
            out.append((file_id, vessel, float(e), float(offset[u]), hashes.get(file_id), float(z)))
    return out


def steps(x):
    """Indices where a series of per-transit offsets steps, by binary segmentation: each
    split goes where it leaves the least absolute deviation from each side's median, and
    stands if the medians differ by more than STEP_M and STEP_SE standard errors."""
    x = np.asarray(x, float)
    found = []

    def cost(y):
        return np.abs(y - np.median(y)).sum()

    # ponytail: each split tries every index, O(n²) in a vessel's transits; fine to a few thousand
    def split(lo, hi):
        candidates = range(lo + STEP_TRANSITS, hi - STEP_TRANSITS + 1)
        if not candidates:
            return
        s = min(candidates, key=lambda s: cost(x[lo:s]) + cost(x[s:hi]))
        left, right = x[lo:s], x[s:hi]
        d = abs(np.median(left) - np.median(right))
        if d > STEP_M and d > STEP_SE * math.hypot(standard_error(left), standard_error(right)):
            found.append(s)
            split(lo, s)
            split(s, hi)

    split(0, len(x))
    return sorted(found)


def segments_from(series):
    """{vessel: [start time of each segment after the first]}."""
    out = {}
    for vessel, (times, offsets) in series.items():
        idx = steps(offsets)
        if idx:
            out[vessel] = [times[i] for i in idx]
    return out


def crossing_transits(con, n_units):
    rows = con.execute("SELECT unit, count(DISTINCT file_id) FROM xobs GROUP BY unit").fetchall()
    n = np.zeros(n_units, int)
    for unit, k in rows:
        n[unit] = k
    return n


def run(con, references=(), accept_losses=False) -> dict:
    """Calibrate every vessel segment and publish the offsets that moved, after sampling
    `references` (see reference.py) at pixels they haven't been sampled at."""
    if not con.execute("SELECT count(*) FROM lake.tide_stations").fetchone()[0]:
        raise RuntimeError("calibration reads tide-reduced depths; run `grid tide` first")
    tiles = reduce(con)
    if references:
        reference.sample(con, references)
    # Pass 1: a unit per vessel, for pixel depths to find steps against.
    names = units_for(con, {})
    if not names:
        log.info("calibrate: no tide-reduced soundings to calibrate")
        return {"tiles": tiles, "segments": 0}
    reference_px(con)
    crossings(con)
    anchor, anchor_se, *_ = anchors(con, len(names))
    first, _, _ = solve(con, len(names), anchor, anchor_se)
    segments = segments_from(series(transit_offsets(con, first)))
    # Pass 2: a unit per segment.
    names = units_for(con, segments)
    crossings(con)
    anchor, anchor_se, pixels, transits = anchors(con, len(names))
    offset, se, anchored = solve(con, len(names), anchor, anchor_se)
    crossed = crossing_transits(con, len(names))
    stray = outliers(con, transit_offsets(con, offset), offset, se, anchored)
    status = np.where(
        ~np.isnan(anchor),
        "anchored",
        np.where(anchored & (crossed >= CROSSING_TRANSITS), "crossover", "uncalibrated"),
    )
    # A negative offset deepens every sounding it corrects, so one past what transducer
    # depths explain, or too uncertain to trust, is kept on record but never applied.
    plausible = (offset >= OFFSET_RANGE_M[0]) & (offset <= OFFSET_RANGE_M[1]) & (se <= MAX_SE_M)
    status = np.where((status != "uncalibrated") & ~plausible, "rejected", status)
    rows = []
    for unit, (vessel, seg) in enumerate(names):
        bounds = [None, *segments.get(vessel, []), None]
        # No anchor reaches it, so it has no offset to speak of.
        solved = bool(anchored[unit])
        rows.append(
            (
                vessel,
                seg,
                bounds[seg],
                bounds[seg + 1],
                float(offset[unit]) if solved else None,
                float(se[unit]) if solved else None,
                str(status[unit]),
                int(pixels[unit]),
                int(transits[unit]),
                int(crossed[unit]),
            )
        )
    # Judged by the offsets that will apply.
    kept = np.array([np.nan if r[4] is None else r[4] for r in keep(con, rows)])
    runs = stuck_runs(con, kept, status)
    dirty = publish(con, rows, stray, accept_losses, runs)
    # The tide the offsets were solved against: once it changes, they are stale.
    con.execute("DELETE FROM lake.store_meta WHERE key = 'calibration_tide'")
    con.execute("INSERT INTO lake.store_meta VALUES ('calibration_tide', ?)", [cells.tides(con)])
    totals = {
        "tiles": tiles,
        "segments": len(rows),
        "steps": sum(len(s) for s in segments.values()),
        **{
            s: int((status == s).sum())
            for s in ("anchored", "crossover", "uncalibrated", "rejected")
        },
        "stray_transits": len(stray),
        "stuck_runs": len(runs),
        "dirty_tiles": dirty,
    }
    for table in (
        "cal_obs",
        "anchor_px",
        "survey_px",
        "file_units",
        "xobs",
        "xrows",
        "unit_offsets",
        "seabed_px",
        "vessel_months",
        "stuck_vessels",
    ):
        con.execute(f"DROP TABLE IF EXISTS {table}")
    log.info("calibrate: %s", totals)
    return totals


def keep(con, rows):
    """`rows` with each segment's published offset kept unless it moved by more than its
    standard error."""
    old = {
        (v, s0, s1, st): (off, se)
        for v, s0, s1, off, se, st in con.execute(
            "SELECT vessel, t_start, t_end, offset_m, se_m, status FROM lake.calibration"
        ).fetchall()
    }
    kept = []
    for v, seg, s0, s1, off, se, st, *rest in rows:
        prev = old.get((v, s0, s1, st))
        if prev and off is not None and prev[0] is not None and abs(off - prev[0]) <= se:
            off, se = prev
        kept.append((v, seg, s0, s1, off, se, st, *rest))
    return kept


def publish(con, rows, stray=(), accept_losses=False, runs=()):
    """Replace the calibration with `rows`, its stray transits with `stray` and its stuck
    runs with `runs`, keeping a segment's published offset unless it moved by more than its
    standard error, then give each file its segment's offset. Returns how many tiles that
    made stale."""
    old = con.execute("SELECT vessel, t_start, t_end, status FROM lake.calibration").fetchall()
    kept = keep(con, rows)
    # A run that would drop most calibrated segments at once found too little to go on
    # (tide levels mid-rebuild, a reference outage), not a fleet that changed overnight.
    before = sum(st in APPLIED for *_, st in old)
    after = sum(r[6] in APPLIED for r in kept)
    if not accept_losses and before >= GUARDED_SEGMENTS and after < (1 - MAX_LOST) * before:
        raise RuntimeError(
            f"calibration would apply {after} segments, down from {before}; check tide and"
            " references, and run `grid calibrate --accept-losses` if it should"
        )
    was_settled = cells.settled(con)
    con.execute("BEGIN")
    try:
        con.execute("DELETE FROM lake.calibration")
        if kept:
            con.executemany(
                "INSERT INTO lake.calibration VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", kept
            )
        con.execute("DELETE FROM lake.calibration_outliers")
        if stray:
            con.executemany(
                "INSERT INTO lake.calibration_outliers VALUES (?, ?, ?, ?, ?, ?)", stray
            )
        con.execute("CREATE OR REPLACE TEMP TABLE old_runs AS SELECT * FROM lake.lost_runs")
        con.execute("DELETE FROM lake.lost_runs")
        if runs:
            con.executemany("INSERT INTO lake.lost_runs VALUES (?, ?, ?, ?, ?)", runs)
        # The tiles of soundings a run now takes, or no longer takes.
        dirty = cells.stale(
            con,
            """SELECT p.tile_id FROM lake.points p JOIN lake.files f USING (file_id)
            JOIN ((SELECT * FROM old_runs EXCEPT SELECT * FROM lake.lost_runs)
              UNION ALL (SELECT * FROM lake.lost_runs EXCEPT SELECT * FROM old_runs)) r
            ON r.content_hash = f.content_hash AND (r.tile_id IS NULL OR r.tile_id = p.tile_id)
              AND p.time BETWEEN r.t_start AND r.t_end""",
            {},
            "calibration",
            was_settled,
        )
        con.execute("DROP TABLE old_runs")
        # The calibration these runs were found under: one that differs, from an older build
        # or a run that stopped short, leaves them stale.
        con.execute("DELETE FROM lake.store_meta WHERE key = 'stuck_runs'")
        con.execute("INSERT INTO lake.store_meta VALUES ('stuck_runs', ?)", [calibrated_by(kept)])
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    return dirty + assign(con, was_settled)


def calibrated_by(rows) -> str:
    """A fingerprint of calibration rows and the stuck-run rule: the runs are current while
    neither changes. Offsets as the table stores them, in single precision."""
    keys = sorted(
        (v, seg, str(s0), str(s1), None if o is None else float(np.float32(o)), st)
        for v, seg, s0, s1, o, _, st, *_ in rows
    )
    # The runs' queries, their constants, and the QC whose flags they read.
    rule = (
        STUCK,
        inspect.getsource(stuck_runs),
        CROWD_VESSELS,
        MONTH_SHARE,
        STUCK_SHARE,
        MONTH_PIXELS,
        QC_VERSION,
    )
    return hashlib.sha256(repr((rule, keys)).encode()).hexdigest()


def runs_current(con) -> bool:
    """Whether the stuck runs were found under this calibration, or there's none to find."""
    rows = con.execute("SELECT * FROM lake.calibration").fetchall()
    if not rows:
        return True
    marker = con.execute("SELECT value FROM lake.store_meta WHERE key = 'stuck_runs'").fetchone()
    return bool(marker) and marker[0] == calibrated_by(rows)


def assign(con, was_settled=None):
    """Give every active file its segment's offset, by its first sounding, and mark the
    tiles of files whose offset changed. Run before every cells build too, so a file that
    arrived since calibration takes its segment's offset. A stray transit takes no offset
    and reads as logged, uncalibrated. A file known to read deep that can't be corrected,
    a segment not applied whose offset is DEEP_M past zero by two standard errors or a
    stray transit measured as deep, is excluded: as logged it would publish too deep. A
    stray transit that lost the bottom, LOST_MARGIN_M shallower than its segment and under
    LOST_BOTTOM of what its segment reads over that seabed, is marked lost_bottom whole;
    stuck stretches inside other files are lake.lost_runs. Returns how many tiles were
    marked. `was_settled`: whether the cells were settled before
    the change this belongs to, as `publish` knows it."""
    if was_settled is None:
        was_settled = cells.settled(con)
    con.execute("BEGIN")
    try:
        # A store from before lost_bottom has NULL there, which is no change from false.
        con.execute(
            "CREATE OR REPLACE TEMP TABLE old_offsets AS SELECT * REPLACE"
            " (coalesce(lost_bottom, false) AS lost_bottom) FROM lake.file_offsets"
        )
        con.execute("DELETE FROM lake.file_offsets")
        con.execute(
            f"""INSERT INTO lake.file_offsets
            WITH stray AS (
              -- A stray transit, by file or by content, as ingest may move its soundings.
              SELECT file_id, max(transit_m) AS transit_m,
                bool_or(transit_m - segment_m < {-LOST_MARGIN_M}
                  AND seabed_m + transit_m < {LOST_BOTTOM} * (seabed_m + segment_m)) AS lost FROM (
                SELECT file_id, transit_m, segment_m, seabed_m FROM lake.calibration_outliers
                UNION ALL
                SELECT f.file_id, o.transit_m, o.segment_m, o.seabed_m FROM lake.files f
                JOIN lake.calibration_outliers o USING (content_hash)
              ) GROUP BY file_id
            ),
            j AS (
              SELECT f.file_id, f.vessel, c.offset_m, c.se_m, c.status IN {APPLIED} AS applied,
                s.file_id IS NOT NULL AS strayed, s.transit_m, s.lost
              FROM lake.files f JOIN lake.calibration c ON c.vessel = f.vessel
                AND (c.t_start IS NULL OR f.time_min >= c.t_start)
                AND (c.t_end IS NULL OR f.time_min < c.t_end)
              LEFT JOIN stray s USING (file_id)
              WHERE f.status = 'active'
            ),
            k AS (
              SELECT *, CASE
                  WHEN strayed THEN transit_m > {DEEP_M + 2 * TRANSIT_SIGMA_M}
                  ELSE NOT applied AND offset_m - 2 * se_m > {DEEP_M}
                END AS excluded,
                strayed AND lost AS lost_bottom
              FROM j
            )
            SELECT file_id, vessel,
              CASE WHEN applied AND NOT strayed THEN offset_m END,
              CASE WHEN applied AND NOT strayed THEN se_m END, coalesce(excluded, false),
              coalesce(lost_bottom, false)
            FROM k WHERE (applied AND NOT strayed) OR excluded OR lost_bottom"""
        )
        dirty = cells.stale(
            con,
            """SELECT tile_id FROM lake.points WHERE file_id IN (
              SELECT file_id FROM (
                (SELECT * FROM lake.file_offsets EXCEPT SELECT * FROM old_offsets)
                UNION ALL (SELECT * FROM old_offsets EXCEPT SELECT * FROM lake.file_offsets)))""",
            {},
            "calibration",
            was_settled,
        )
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    con.execute("DROP TABLE old_offsets")
    return dirty
