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
by binary segmentation. The second solve has one unit per segment. Each solve is repeated
without the medians that read lost against its offsets (see `solve_without_lost`), so a
vessel that often loses the bottom isn't calibrated shallow, but a transit left with too few
others is measured whole: a sounder's real move reads lost until it's found. A segment without
an anchor counts as calibrated from CROSSING_TRANSITS crossing transits, when its
crossings link it to an anchored one. Only calibrated offsets are applied, and only plausible ones
(OFFSET_RANGE_M, MAX_SE_M): an uncalibrated vessel reads as it was logged, usually shoal,
which errs safe, while a wrong negative offset would deepen every sounding it corrects.
Anything known to read deep that isn't corrected is left out (see `assign`).

No depth scale factor is fitted: at 2–20 m it barely narrows the spread.
"""

import bisect
import contextlib
import functools
import hashlib
import inspect
import itertools
import logging
import math
import os
import time
from datetime import datetime
from pathlib import Path

import duckdb
import numpy as np
from scipy.sparse import coo_matrix, csc_matrix, csr_matrix, diags
from scipy.sparse.csgraph import connected_components
from scipy.sparse.linalg import splu

from . import catalog, cells, manifest, ranges, reference
from . import release as release_memory
from .cells import BASE, K_LIST
from .qc import QC_VERSION, TRACK_REASONS

log = logging.getLogger(__name__)

# The connection whose working tables `on_disk` holds in a file, and the file's WAL,
# while it does.
working = None


def release():
    """Hand back what a unit of work freed: the process's memory, and the blocks of the
    working tables it dropped or replaced, which the file reuses only after a checkpoint
    and otherwise grows by, a copy per replacement. Only after a write: the WAL is gone
    from one checkpoint to the next write, so a loop that only reads costs nothing."""
    release_memory()
    if working is not None and working[1].exists():
        working[0].execute("CHECKPOINT cal")


@contextlib.contextmanager
def step(name):
    """Log a step's start and its seconds once done, so a long step never goes silent."""
    log.info("calibrate: %s", name)
    t = time.monotonic()
    yield
    log.info("calibrate: %s took %.0f s", name, time.monotonic() - t)


def on_disk(fn):
    """Run `fn(con, ...)` with its working tables in a database file in DuckDB's temp
    directory. They hold every file-pixel median of the store, a planet's beyond any
    memory: in a file, DuckDB keeps them compressed and reads them back a block at a time,
    where temp tables past the memory limit spill uncompressed. Tables made inside a
    transaction that writes `lake` stay TEMP, since a transaction writes one database."""

    @functools.wraps(fn)
    def wrapped(con, *args, **kwargs):
        temp = con.execute("SELECT current_setting('temp_directory')").fetchone()[0]
        path = Path(temp) / f"calibrate-{os.getpid()}.duckdb"
        path.parent.mkdir(parents=True, exist_ok=True)
        wal = path.with_name(path.name + ".wal")
        # A killed run of the same pid (1, in a container) can leave its file behind.
        path.unlink(missing_ok=True)
        wal.unlink(missing_ok=True)
        was = con.execute("SELECT current_database()").fetchone()[0]
        con.execute(f"ATTACH {catalog.literal(str(path))} AS cal")
        global working
        try:
            con.execute("USE cal")
            working = con, wal
            return fn(con, *args, **kwargs)
        finally:
            working = None
            # A transaction `fn` left open would refuse the switch and hide its error.
            with contextlib.suppress(duckdb.Error):
                con.execute("ROLLBACK")
            con.execute(f'USE "{was}"')
            # Or detaching writes out the tables a failed run left, only to delete them.
            for (table,) in con.execute(
                "SELECT table_name FROM duckdb_tables() WHERE database_name = 'cal'"
            ).fetchall():
                con.execute(f'DROP TABLE cal."{table}"')
            con.execute("DETACH cal")
            path.unlink(missing_ok=True)
            wal.unlink(missing_ok=True)

    return wrapped


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
# A sounder that moved reads the seabed from a new depth, and a lost one reads nothing of it:
# a segment's readings against the survey, where its depths spread SEABED_SPREAD_M or more,
# fall under FOLLOWS_SEABED of a metre per metre of depth only if it's lost, and it's no step.
# On the Chesapeake store one vessel held 0 m over 3 to 22 m for three months, a slope of 0.00.
FOLLOWS_SEABED = 0.5
SEABED_SPREAD_M = 1.0
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
# A searched vessel's lost readings over a flat, well-surveyed pixel (relief under
# FLAT_RELIEF_M, uncertainty under ANCHOR_UNCERTAINTY_M) are set aside however they wander,
# a stretch of them at a time: water that flat is no slip or bank a sounder reads true. On
# the Chesapeake store one vessel's Gulf transit read 0.4 to 1.4 m in 20 m of water, in
# stretches of a median 6 to 11 readings, never steady enough to be a stuck run. A stretch
# counts from FLAT_REACH_M, far less than a run's, at FLAT_SPEED_MS or faster: those hold
# 95% of these soundings, and a spike goes nowhere, and a boat at its mooring no faster
# than its GPS wanders. Over water that has shoaled since the survey, with too few vessels
# to say so, true readings are set aside too: they publish as unconfirmed shoals from 0.5 m.
FLAT_RELIEF_M = 0.5
FLAT_REACH_M = 20
FLAT_SPEED_MS = 0.5
# The seabed a run is judged over: the survey's, or the median of the corrected depths of
# at least CROWD_VESSELS vessels, whichever is shallower, so water that has shoaled since
# the survey isn't mistaken for a lost bottom. Against the survey on the Chesapeake, three
# vessels found 96% of the soundings it did, at 98% precision.
CROWD_VESSELS = 3
# Calibration's medians that read lost against a solve's offsets, by the same test, are left
# out of the next solve, which is judged again, for at most LOST_PASSES passes: a vessel that
# often loses the bottom would otherwise be calibrated too shallow, and every sounding it
# reads true corrected too deep. Only readings the solve can already tell from the rest: where
# lost ones are most of a vessel's, its offset settles among them and none reads lost.
LOST_PASSES = 3
# Soundings per batch of a vessel's files in a tile, searched for stuck runs at once: one
# vessel's 5.0M in a Chesapeake tile ran out of memory at a 768 MB limit.
SEARCH_POINTS = 1_000_000
# Soundings and vessels of one tile read at once for the stuck-run search, which then takes
# each vessel's from them: read per vessel, a tile was read once for each of its searched
# vessels. Each read holds its soundings, and the vessel list is checked for each of the
# tile's soundings.
SEARCH_READ = 3_000_000
SEARCH_VESSELS = 64
# DuckDB threads for the stuck-run search: each holds its own share of a pair's soundings,
# and on 4 a vessel's 5.0M in one tile took under 512 MB, against more than 640 MB on 18.
SEARCH_THREADS = 4
# Rows per batch of files whose per-transit medians are taken at once (transit_offsets).
TRANSIT_ROWS = 2_000_000
# Rows of `cal_obs` per run of tiles read at once by a statement over every tile: whole, the
# planet's joins and medians spilled past 25 GB. Every row of a pixel is in its tile.
TILE_ROWS = 2_000_000
# A vessel's calendar month in a 1° tile with MONTH_SHARE or more of its pixels there
# reading lost (from MONTH_PIXELS judged) is set aside in that tile, so a sounder that lost
# the bottom in one bay keeps its soundings in the next: with stuck runs and stretches, 2.54M
# soundings on the Chesapeake store, where judging the month across its tiles set aside 3.05M. A tile
# with too few judged pixels to say takes the verdict of the month across its tiles. A
# vessel with any month at STUCK_SHARE or more, across its tiles, has its stuck runs found
# too; the others aren't searched.
MONTH_SHARE = 0.2
STUCK_SHARE = 0.05
MONTH_PIXELS = 100
# Of a store's calibrated segments, more than this share lost in one run is refused.
MAX_LOST = 0.5
GUARDED_SEGMENTS = 20

# Each vessel's median tide-reduced depth per file per calibration pixel (two base rows
# by two base columns), from soundings track QC accepted, for the files in `cal_dirty`.
# Read a unit of tiles or a band of one at a time, whose rows hold whole pixels.
REDUCE = f"""
INSERT INTO lake.file_medians BY NAME
SELECT p.tile_id, floor((p.lat - (p.tile_id // 360 - 90)) * {BASE} / 2)::INTEGER AS py,
  floor((p.lon - (p.tile_id % 360 - 180)) * {BASE}
    / {K_LIST}[p.tile_id // 360 - 90 + 91] / 2)::INTEGER AS px,
  p.unique_id AS vessel, p.file_id, min(p.time) AS t,
  median(p.depth_raw - coalesce(p.tide, 0))::FLOAT AS m, max(p.time) AS t_last
FROM corrected_points_in($partition, $tiles, $rlo, $rhi, vessels := $vessels) p
WHERE p.file_id IN (SELECT file_id FROM cal_dirty)
  AND p.depth_raw > 0 AND p.depth_raw <= {MAX_DEPTH_M} AND p.time IS NOT NULL
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

# Soundings per unit of REDUCE's work: its per-pixel medians can't spill, and at a 768 MB
# limit and 18 threads a band of tile 45463 ran out of memory in units of cells' 5M.
REDUCE_POINTS = 1_250_000
# Base rows per band: an even number, so no pixel is split between two.
REDUCE_ROWS = 18

# Each active file's soundings per tile and their batches, keyed so a file whose
# soundings moved has its tide cells found again (FILE_TIDE_CELLS).
FILE_OWN = """
SELECT file_id, left(sha256(concat_ws('/', $code, sum(hash(tile_id, batch_id, n)::HUGEINT))), 16)
  AS own
FROM lake.file_tiles WHERE file_id IN (SELECT file_id FROM lake.files WHERE status = 'active')
GROUP BY 1
"""
# The tide cells a file's soundings fall in, so a cell `grid tide` adds for a new file
# moves no other file of its tile.
FILE_TIDE_CELLS = f"""
INSERT INTO lake.file_tide_cells
SELECT DISTINCT p.file_id, s.own, {catalog.TIDE_CELL} FROM lake.points p JOIN cal_stale s USING (file_id)
WHERE p.cell_id = ?
"""
TIDE_CELLS_CODE = hashlib.sha256(repr((FILE_OWN, FILE_TIDE_CELLS)).encode()).hexdigest()[:16]

# What each active file's own medians are made of, as parts summed from hashes of rows,
# so the order rows come in doesn't matter: its soundings per tile and their batches; its
# track flags; and its tide cells and their stations, with those stations' levels on the
# days it covers. The files dedupe compares it with are DEPENDENTS'.
MEDIAN_INPUTS = f"""
WITH f AS (
  SELECT file_id, source, vessel, content_hash, time_min, time_max FROM lake.files
  WHERE status = 'active'
),
own AS (
  SELECT file_id, sum(hash(tile_id, batch_id, n)::HUGEINT) AS h FROM lake.file_tiles GROUP BY 1
),
flags AS (
  SELECT point_id >> 32 AS file_id, sum(hash(point_id, flag, reason)::HUGEINT) AS h
  FROM lake.qc_flags WHERE qc_version = {QC_VERSION} AND list_contains({TRACK_REASONS}, reason)
    AND flag IN ('reject', 'unconfirmed', 'noisy')
  GROUP BY 1
),
cells AS (
  SELECT DISTINCT x.file_id, x.tide_cell, c.tide_cell IS NOT NULL AS assigned, c.station_id
  FROM lake.file_tide_cells x LEFT JOIN lake.tide_cells c USING (tide_cell)
),
stations AS (
  SELECT file_id, sum(hash(tide_cell, assigned, station_id)::HUGEINT) AS h FROM cells GROUP BY 1
),
days AS (
  SELECT DISTINCT d.file_id, s.station_id, d.day FROM (
    SELECT file_id, unnest(generate_series(time_min::DATE, time_max::DATE, INTERVAL 1 DAY))::DATE
      AS day
    FROM f WHERE time_min IS NOT NULL AND time_max IS NOT NULL
  ) d JOIN (
    SELECT DISTINCT file_id, station_id FROM cells WHERE station_id IS NOT NULL
  ) s USING (file_id)
),
levels AS (
  SELECT station_id, slot::DATE AS day,
    sum(hash(station_id, slot, level, slope, sigma)::HUGEINT) AS h
  FROM lake.tide_levels WHERE (station_id, slot::DATE) IN (SELECT (station_id, day) FROM days)
  GROUP BY ALL
),
tide AS (
  SELECT d.file_id, sum(l.h) AS h FROM days d JOIN levels l USING (station_id, day) GROUP BY 1
)
SELECT f.file_id, f.vessel, left(sha256(concat_ws(
    '/', $code, f.source, f.vessel, f.content_hash, f.time_min, f.time_max, coalesce(own.h, 0),
    coalesce(flags.h, 0), coalesce(stations.h, 0), coalesce(tide.h, 0)
  )), 16) AS inputs
FROM f LEFT JOIN own USING (file_id) LEFT JOIN flags USING (file_id)
LEFT JOIN stations USING (file_id) LEFT JOIN tide USING (file_id)
"""

# The files to reduce: those whose own inputs moved, and the active files whose soundings
# dedupe weighs against a file that moved, came or went (catalog.ACTIVE). Under rule 4 that
# is the higher file_ids of its source and vessel over its time, since the lowest keeps a
# shared sounding; under rule 5 the NOAA files of an Open Waters file's vessel over its
# time, widened to whole seconds. Only files that haven't moved are joined, so a first run
# doesn't pair every file of a vessel with every other.
DEPENDENTS = """
CREATE OR REPLACE TABLE cal_dirty AS
WITH moved AS (
  SELECT file_id FROM cal_inputs ANTI JOIN lake.file_median_inputs USING (file_id, inputs)
  UNION SELECT file_id FROM lake.file_median_inputs ANTI JOIN cal_inputs USING (file_id)
),
m AS (SELECT file_id, source, vessel, time_min, time_max FROM lake.files SEMI JOIN moved USING (file_id)),
rest AS (
  SELECT c.file_id, f.source, f.vessel, f.time_min, f.time_max
  FROM (FROM cal_inputs ANTI JOIN moved USING (file_id)) c JOIN lake.files f USING (file_id)
)
SELECT file_id, vessel FROM cal_inputs SEMI JOIN moved USING (file_id)
UNION
SELECT DISTINCT r.file_id, r.vessel FROM rest r JOIN m ON m.vessel = r.vessel AND (
  (m.source = r.source AND m.file_id < r.file_id
    AND m.time_min <= r.time_max AND m.time_max >= r.time_min)
  OR (m.source = 'openwaters' AND r.source = 'noaa'
    AND date_trunc('second', m.time_min) <= r.time_max
    AND date_trunc('second', m.time_max) + INTERVAL 1 SECOND > r.time_min))
"""


def as_hashed(text):
    """`text` as the fingerprints hash it: with its working tables TEMP, as they were
    before `on_disk`, which changes where they're kept and not what they hold."""
    return text.replace("CREATE OR REPLACE TABLE", "CREATE OR REPLACE TEMP TABLE")


# The code a file's medians come from: once it changes, every file is reduced again.
CODE = hashlib.sha256(
    repr(
        (REDUCE, TIDE_CELLS_CODE, MEDIAN_INPUTS, as_hashed(DEPENDENTS), catalog.ACTIVE_POINTS)
    ).encode()
).hexdigest()[:16]

# Rows at anchor-quality reference pixels (`anchor_px`) in the tiles `$lo` to `$hi`, with the
# difference from the reference and whether the row reads lost.
ANCHOR_ROWS = f"""
SELECT o.vessel, o.file_id, o.t, o.tile_id, o.py, o.px, o.m - r.depth AS e, r.depth AS z, o.lost
FROM cal_obs o JOIN anchor_px r USING (tile_id, py, px)
WHERE abs(o.m - r.depth) < {ANCHOR_DIFF_M} AND o.tile_id BETWEEN $lo AND $hi
  AND r.tile_id BETWEEN $lo AND $hi
"""

# The working table `search_soundings`: one tile's soundings of the vessels in `$vessels`; then
# `searched`: those of `$vessel`, each file's in order (ties broken by row, so a run comes out
# the same every time), and whether each reads lost over a seabed (`unit_offsets`,
# `seabed_px`). Two statements, on SEARCH_THREADS: as one, on 18, a vessel's 5.0M soundings in
# a Chesapeake tile ran out of memory at a 768 MB limit.
SEARCH = (
    f"""
CREATE OR REPLACE TABLE search_soundings AS
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
      AND NOT (flag = 'unconfirmed' AND reason = 'flatline'))""",
    f"""
CREATE OR REPLACE TABLE searched AS
SELECT p.*,
  coalesce(tr < {LOST_BOTTOM} * (u.o + s.z) AND tr < u.o + s.z - {LOST_MARGIN_M}, false) AS lost,
  coalesce(s.flat, false) AS flat,
  row_number() OVER (PARTITION BY p.file_id ORDER BY time, raw, row) AS i
FROM search_soundings p JOIN unit_offsets u USING (vessel, file_id)
LEFT JOIN seabed_px s ON s.tile_id = $tile AND s.py = p.py AND s.px = p.px
WHERE p.vessel = $vessel""",
)
# Those of a batch of files at a time, a run of file ids in order read as their range `$lo`
# to `$hi`: every window and run is within a file.
SEARCHED = "WITH w AS (FROM searched WHERE file_id BETWEEN $lo AND $hi)"

# Stuck runs: stuck windows joined where they overlap. A run counts from STUCK_RUN stuck
# windows across STUCK_REACH_M, and starts and ends on a lost reading, so a bank crossed
# just before the sounder sticks at its depth isn't in it.
STUCK = f"""{SEARCHED},
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

# Each stretch of lost readings over flat pixels in one tile, a query of its own so the
# soundings aren't held for both.
FLAT = f"""{SEARCHED},
k AS (
  SELECT *, i - row_number() OVER (PARTITION BY file_id, lost AND flat ORDER BY time, raw, row)
    AS run
  FROM w
),
s AS (
  SELECT f.content_hash, k.vessel, min(k.time) AS t_start, max(k.time) AS t_end,
    6371000 * sqrt(pow(radians(max(k.lat) - min(k.lat)), 2)
      + pow(radians(max(k.lon) - min(k.lon)) * cos(radians(avg(k.lat))), 2)) AS reach
  FROM k JOIN lake.files f USING (file_id) WHERE k.lost AND k.flat
  GROUP BY f.content_hash, k.vessel, k.file_id, k.run
)
SELECT content_hash, vessel, $tile AS tile_id, t_start, t_end FROM s
WHERE reach >= {FLAT_REACH_M} AND reach >= {FLAT_SPEED_MS} * epoch(t_end - t_start)
"""


# The tiles of soundings under a run in `old_runs` or `lake.lost_runs` but not both. The
# changed runs are merged where they overlap for each content and tile, so a sounding falls
# in at most one and is matched to the last that starts before it, by ASOF join: on a first
# calibrate every run is new, and checking each sounding against all of its file's runs is
# its soundings times its runs (9.1 billion pairs on the Chesapeake, up to 3,130 runs a file).
CHANGED_RUN_TILES = """
WITH c AS (
  (SELECT * FROM old_runs EXCEPT SELECT * FROM lake.lost_runs)
  UNION ALL (SELECT * FROM lake.lost_runs EXCEPT SELECT * FROM old_runs)
),
r AS (
  SELECT *, max(t_end) OVER (PARTITION BY content_hash, tile_id ORDER BY t_start, t_end
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS reach
  FROM c
),
s AS (
  SELECT content_hash, tile_id, min(t_start) AS t_start, max(t_end) AS t_end FROM (
    SELECT *, sum(coalesce(t_start > reach, true)::INTEGER) OVER (
        PARTITION BY content_hash, tile_id ORDER BY t_start, t_end) AS island
    FROM r
  ) GROUP BY content_hash, tile_id, island
),
d AS (SELECT f.file_id, s.tile_id, s.t_start, s.t_end FROM s JOIN lake.files f USING (content_hash)),
p AS (SELECT file_id, tile_id, time FROM lake.points WHERE file_id IN (SELECT file_id FROM d))
SELECT p.tile_id FROM p ASOF JOIN (FROM d WHERE tile_id IS NOT NULL) d
  ON d.file_id = p.file_id AND d.tile_id = p.tile_id AND p.time >= d.t_start
WHERE p.time <= d.t_end
UNION ALL
-- A run with no tile, from a store not yet recalibrated, holds in every tile.
SELECT p.tile_id FROM p ASOF JOIN (FROM d WHERE tile_id IS NULL) d
  ON d.file_id = p.file_id AND p.time >= d.t_start
WHERE p.time <= d.t_end
"""


def fill_tide_cells(con):
    """Find the tide cells of each active file whose soundings are new or moved, a
    partition at a time, in one transaction, so no file is left with only some."""
    con.execute(f"CREATE OR REPLACE TABLE cal_own AS {FILE_OWN}", {"code": TIDE_CELLS_CODE})
    con.execute(
        """CREATE OR REPLACE TABLE cal_stale AS FROM cal_own
        ANTI JOIN (SELECT DISTINCT file_id, own FROM lake.file_tide_cells) USING (file_id, own)"""
    )
    try:
        con.execute("BEGIN")
        try:
            con.execute(
                """DELETE FROM lake.file_tide_cells WHERE file_id NOT IN (SELECT file_id FROM cal_own)
                OR file_id IN (SELECT file_id FROM cal_stale)"""
            )
            for (partition,) in con.execute(
                """SELECT DISTINCT cell_id FROM lake.file_tiles SEMI JOIN cal_stale USING (file_id)
                ORDER BY 1"""
            ).fetchall():
                con.execute(FILE_TIDE_CELLS, [partition])
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
    finally:
        con.execute("DROP TABLE cal_stale")
        con.execute("DROP TABLE cal_own")


def reduce(con, full=False):
    """Fill the working table `cal_obs` from each active file's kept medians, after reducing
    again the files whose inputs moved (MEDIAN_INPUTS, DEPENDENTS), or every file if
    `full`, in units of REDUCE_POINTS soundings, so memory follows a unit rather than the
    densest tile.
    Returns how many tiles and files it read."""
    manifest.ensure_file_tiles(con)
    fill_tide_cells(con)
    con.execute(f"CREATE OR REPLACE TABLE cal_inputs AS {MEDIAN_INPUTS}", {"code": CODE})
    con.execute(
        "CREATE OR REPLACE TABLE cal_dirty AS SELECT file_id, vessel FROM cal_inputs"
        if full
        else DEPENDENTS
    )
    # Inputs first: a run stopped from here on finds these files to reduce again.
    con.execute(
        """DELETE FROM lake.file_median_inputs WHERE file_id IN (SELECT file_id FROM cal_dirty)
        OR file_id NOT IN (SELECT file_id FROM cal_inputs)"""
    )
    con.execute(
        """DELETE FROM lake.file_medians
        WHERE file_id NOT IN (SELECT file_id FROM lake.file_median_inputs)"""
    )
    # Every vessel's, rather than a list of them all, where a partition's every vessel has a
    # file to reduce: the list is searched for each sounding.
    parts = con.execute(
        """SELECT t.cell_id,
          list(DISTINCT t.tile_id ORDER BY t.tile_id) FILTER (WHERE d.file_id IS NOT NULL),
          CASE WHEN count(DISTINCT c.vessel) = count(DISTINCT d.vessel) THEN []
            ELSE list(DISTINCT d.vessel ORDER BY d.vessel) FILTER (WHERE d.file_id IS NOT NULL) END
        FROM lake.file_tiles t JOIN cal_inputs c USING (file_id)
        LEFT JOIN cal_dirty d USING (file_id)
        GROUP BY 1 HAVING count(d.file_id) > 0 ORDER BY 1"""
    ).fetchall()
    tiles = set()
    for partition, dirty_tiles, vessels in parts:
        for unit, rlo, rhi in cells.units(
            con, partition, dirty_tiles, rows=REDUCE_ROWS, points=REDUCE_POINTS
        ):
            con.execute(
                REDUCE,
                {
                    "partition": partition,
                    "tiles": unit,
                    "rlo": rlo,
                    "rhi": rhi,
                    "vessels": vessels,
                },
            )
            release()
            tiles.update(unit)
    con.execute(
        """INSERT INTO lake.file_median_inputs
        SELECT file_id, inputs FROM cal_inputs WHERE file_id IN (SELECT file_id FROM cal_dirty)"""
    )
    [(files, of)] = con.execute(
        "SELECT (SELECT count(*) FROM cal_dirty), (SELECT count(*) FROM cal_inputs)"
    ).fetchall()
    log.info("calibrate: reduced %d of %d files, in %d tiles", files, of, len(tiles))
    # Whether a median reads lost depends on the offsets, so it's judged each run, not kept.
    con.execute("CREATE OR REPLACE TABLE cal_obs AS SELECT *, false AS lost FROM lake.file_medians")
    con.execute("DROP TABLE cal_inputs")
    con.execute("DROP TABLE cal_dirty")
    return len(tiles), files


def reference_px(con):
    """The temp tables `anchor_px`, the reference that would anchor at each pixel, and
    `survey_px`, the depth of each pixel a reference has one for and whether it's flat
    (FLAT_RELIEF_M): at each pixel, the reference with the least uncertainty there. Picked
    once per run and a tile at a time, so memory follows a tile's reference pixels rather than every one."""
    best = "QUALIFY row_number() OVER (PARTITION BY py, px ORDER BY uncertainty, source) = 1"
    con.execute(
        """CREATE OR REPLACE TABLE anchor_px (tile_id INTEGER, py INTEGER, px INTEGER,
        depth FLOAT)"""
    )
    con.execute(
        """CREATE OR REPLACE TABLE survey_px (tile_id INTEGER, py INTEGER, px INTEGER,
        depth FLOAT, flat BOOLEAN)"""
    )
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
            f"""INSERT INTO survey_px SELECT tile_id, py, px, depth,
              coalesce(relief < {FLAT_RELIEF_M} AND uncertainty < {ANCHOR_UNCERTAINTY_M}, false)
            FROM lake.reference_pixels
            WHERE tile_id = $tile AND depth IS NOT NULL {best}""",
            {"tile": tile},
        )


def stuck_runs(con, offset, status):
    """Runs of soundings whose sounder lost the bottom, as rows (content hash, vessel, tile,
    start, end): every file of a month set aside in a tile, there and that month, and the
    stuck runs and lost readings over flat pixels of the vessels with a month at
    STUCK_SHARE. From segments whose offset is applied: only those say what a vessel should
    read."""
    applied = np.isin(status, APPLIED)
    con.register("offsets_np", {"unit": np.flatnonzero(applied), "o": np.asarray(offset)[applied]})
    con.execute(
        """CREATE OR REPLACE TABLE unit_offsets AS
        SELECT u.vessel, u.file_id, o.o FROM file_units u JOIN offsets_np o USING (unit)"""
    )
    con.unregister("offsets_np")
    # A tile at a time: the medians can't spill, and every row of a pixel is in its tile.
    con.execute(
        """CREATE OR REPLACE TABLE seabed_px (tile_id INTEGER, py INTEGER, px INTEGER,
        z DOUBLE, flat BOOLEAN)"""
    )
    for (tile,) in con.execute("SELECT DISTINCT tile_id FROM cal_obs ORDER BY 1").fetchall():
        con.execute(
            f"""INSERT INTO seabed_px
            WITH crowd AS (
              SELECT tile_id, py, px, median(z) AS z FROM (
                SELECT o.tile_id, o.py, o.px, o.vessel, median(o.m - u.o) AS z
                FROM cal_obs o JOIN unit_offsets u USING (vessel, file_id)
                WHERE o.tile_id = $tile GROUP BY ALL)
              GROUP BY ALL HAVING count(*) >= {CROWD_VESSELS}
            )
            -- least() passes over a NULL: either alone, or the shallower of both.
            SELECT tile_id, py, px, least(s.depth, c.z) AS z, s.flat
            FROM (FROM survey_px WHERE tile_id = $tile) s FULL JOIN crowd c
              USING (tile_id, py, px)""",
            {"tile": tile},
        )
        release()
    # Each vessel's calendar months in each tile: how many of its file-pixel medians were
    # judged, and how many read lost.
    lost = f"o.m < {LOST_BOTTOM} * (s.z + u.o) AND o.m < s.z + u.o - {LOST_MARGIN_M}"
    # Grouped by tile, so a run of tiles at a time gives the same rows, and the joins' memory
    # follows a run.
    months = f"""SELECT o.vessel, date_trunc('month', o.t) AS month, o.tile_id, count(*) AS judged,
          count(*) FILTER (WHERE {lost}) AS lost
        FROM cal_obs o JOIN unit_offsets u USING (vessel, file_id)
        JOIN seabed_px s USING (tile_id, py, px)
        WHERE o.tile_id BETWEEN $lo AND $hi AND s.tile_id BETWEEN $lo AND $hi
        GROUP BY ALL"""
    tiles = tile_ranges(con)
    con.execute(f"CREATE OR REPLACE TABLE vessel_months AS {months}", {"lo": 0, "hi": -1})
    for lo, hi in tiles:
        con.execute(f"INSERT INTO vessel_months {months}", {"lo": lo, "hi": hi})
        release()
    # Searched by the month across its tiles, as the search finds runs in any of them.
    con.execute(
        f"""CREATE OR REPLACE TABLE stuck_vessels AS
        SELECT DISTINCT vessel FROM vessel_months GROUP BY vessel, month
        HAVING sum(judged) >= {MONTH_PIXELS} AND sum(lost) >= {STUCK_SHARE} * sum(judged)"""
    )
    # A month set aside in a tile: each of its files' soundings there, to the end of the
    # last month its lost medians reach, as a median holds every visit to its pixel.
    set_aside = f"""WITH months AS (
          SELECT vessel, month, sum(judged) AS judged, sum(lost) AS lost
          FROM vessel_months GROUP BY ALL
        )
        SELECT f.content_hash, f.vessel, o.tile_id, greatest(f.time_min, a.month),
          least(f.time_max, coalesce(max(date_trunc('month', o.t_last)) FILTER (WHERE {lost}),
            a.month) + INTERVAL 1 MONTH - INTERVAL 1 MICROSECOND)
        FROM cal_obs o JOIN unit_offsets u USING (vessel, file_id) JOIN months a
          ON a.vessel = o.vessel AND a.month = date_trunc('month', o.t)
        LEFT JOIN (FROM seabed_px WHERE tile_id BETWEEN $lo AND $hi) s USING (tile_id, py, px)
        LEFT JOIN vessel_months m
          ON m.vessel = a.vessel AND m.month = a.month AND m.tile_id = o.tile_id
        JOIN lake.files f ON f.file_id = o.file_id
        WHERE f.status = 'active' AND o.tile_id BETWEEN $lo AND $hi
          AND CASE WHEN m.judged >= {MONTH_PIXELS}
          THEN m.lost >= {MONTH_SHARE} * m.judged
          ELSE a.judged >= {MONTH_PIXELS} AND a.lost >= {MONTH_SHARE} * a.judged END
        GROUP BY f.content_hash, f.vessel, o.tile_id, f.time_min, f.time_max, a.month"""
    runs = []
    for lo, hi in tiles:
        runs += con.execute(set_aside, {"lo": lo, "hi": hi}).fetchall()
        release()
    # ponytail: a file's run is found and applied per tile, so one that crosses a tile edge
    # is two; judge across tiles if the seams show
    # A tile's soundings for a group of its vessels at a time (SEARCH_READ), then one vessel's
    # of those, and its windows a batch of files at a time, so memory follows a read rather
    # than every searched vessel's soundings in the tile.
    # ponytail: a vessel's soundings in a tile are still read at once (5.3M on the
    # Chesapeake); read them a range of files at a time if a liveaboard outgrows the limit
    threads = con.execute("SELECT current_setting('threads')").fetchone()[0]
    con.execute(f"SET threads = {min(threads, SEARCH_THREADS)}")
    try:
        for partition, tile, vessels in stuck_reads(con):
            t = time.monotonic()
            soundings, judged = SEARCH
            [(n,)] = con.execute(
                soundings,
                {"partition": partition, "tile": tile, "vessels": [v for v, _ in vessels]},
            ).fetchall()
            found = len(runs)
            for vessel, batches in vessels:
                con.execute(judged, {"tile": tile, "vessel": vessel})
                for files in batches:
                    params = {"tile": tile, "lo": files[0], "hi": files[-1]}
                    runs += (
                        con.execute(STUCK, params).fetchall() + con.execute(FLAT, params).fetchall()
                    )
                    release()
            log.info(
                "calibrate: searched tile %d for %d vessels: %d soundings, %d runs, %.1f s",
                tile,
                len(vessels),
                n,
                len(runs) - found,
                time.monotonic() - t,
            )
    finally:
        con.execute(f"SET threads = {threads}")
        con.execute("DROP TABLE IF EXISTS search_soundings")
        con.execute("DROP TABLE IF EXISTS searched")
    # A stretch can be a run to the reading.
    return list(dict.fromkeys(runs))


def stuck_reads(con):
    """(partition, tile, [(vessel, batches of file ids)]) for the vessels in `stuck_vessels`
    with soundings in a tile any of them has medians in: a vessel whose soundings in a tile
    are all held depths has none of its own there, and is searched all the same. A tile's
    vessels are read in groups of up to SEARCH_READ soundings and SEARCH_VESSELS vessels, or
    one vessel with more, and a vessel's files searched in batches of about SEARCH_POINTS.
    Memory a read's search freed is handed back before the next."""
    rows = con.execute(
        """SELECT cell_id, tile_id, unique_id, file_id, count(*) FROM lake.points
        WHERE unique_id IN (SELECT vessel FROM stuck_vessels)
          AND tile_id IN (SELECT DISTINCT tile_id FROM cal_obs
            WHERE vessel IN (SELECT vessel FROM stuck_vessels))
        GROUP BY ALL ORDER BY ALL"""
    ).fetchall()
    for key, pairs in itertools.groupby(rows, lambda r: r[:2]):
        group, read = [], 0
        for vessel, files in itertools.groupby(pairs, lambda r: r[2]):
            batches, size, total = [[]], 0, 0
            for *_, file_id, n in files:
                if batches[-1] and size + n > SEARCH_POINTS:
                    batches.append([])
                    size = 0
                batches[-1].append(file_id)
                size += n
                total += n
            if group and (read + total > SEARCH_READ or len(group) == SEARCH_VESSELS):
                yield (*key, group)
                group, read = [], 0
            group.append((vessel, batches))
            read += total
        release()
        yield (*key, group)


def units_for(con, segments):
    """The working table `file_units`: each vessel file's unit, by its segments' start times.

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
    con.execute("CREATE OR REPLACE TABLE file_units (vessel VARCHAR, file_id BIGINT, unit INTEGER)")
    if rows:
        v, f, u = zip(*rows)
        arrays = {"vessel": np.array(v), "file_id": np.array(f), "unit": np.array(u)}
        con.register("units_np", arrays)
        con.execute("INSERT INTO file_units SELECT * FROM units_np")
        con.unregister("units_np")
    return names


def crossings(con):
    """The working table `xrows`: each unit's median at pixels two or more units share, from
    rows not read lost, weighted so each transit counts once across its crossing pixels.
    Only `solved` pixels, which two units share without their lost rows, enter the solve:
    the others only give a transit that lost the bottom a depth to show it against, as the
    lost rows `xobs` keeps do."""
    # A tile at a time: the medians can't spill, and every row of a pixel is in its tile.
    tiles = [
        t for (t,) in con.execute("SELECT DISTINCT tile_id FROM cal_obs ORDER BY 1").fetchall()
    ]
    con.execute(
        """CREATE OR REPLACE TABLE xobs AS
        SELECT o.*, u.unit, true AS solved FROM cal_obs o JOIN file_units u USING (vessel, file_id)
        LIMIT 0"""
    )
    for tile in tiles:
        con.execute(
            """INSERT INTO xobs
            WITH o AS (
              SELECT o.*, u.unit FROM cal_obs o JOIN file_units u USING (vessel, file_id)
              WHERE o.tile_id = $tile
            ),
            shared AS (
              SELECT tile_id, py, px, count(DISTINCT unit) FILTER (WHERE NOT lost) >= 2 AS solved
              FROM o GROUP BY ALL HAVING count(DISTINCT unit) >= 2
            )
            SELECT o.*, shared.solved FROM o JOIN shared USING (tile_id, py, px)""",
            {"tile": tile},
        )
    con.execute(
        """CREATE OR REPLACE TABLE xweights AS
        SELECT vessel, file_id, count(*) FILTER (WHERE solved) AS solved_n, count(*) AS n
        FROM xobs WHERE NOT lost GROUP BY ALL"""
    )
    con.execute(
        """CREATE OR REPLACE TABLE xrows (tile_id INTEGER, py INTEGER, px INTEGER,
        unit INTEGER, solved BOOLEAN, m FLOAT, b DOUBLE)"""
    )
    for tile in tiles:
        con.execute(
            """INSERT INTO xrows
            SELECT tile_id, py, px, unit, solved, median(m) AS m,
              sum(1.0 / CASE WHEN solved THEN n.solved_n ELSE n.n END) AS b
            FROM xobs x JOIN xweights n USING (vessel, file_id)
            WHERE x.tile_id = $tile AND NOT x.lost GROUP BY ALL""",
            {"tile": tile},
        )
        release()
    con.execute("DROP TABLE xweights")


def tile_ranges(con):
    """Runs of tiles (first, last) holding about TILE_ROWS of `cal_obs` rows each."""
    return ranges(
        con.execute("SELECT tile_id, count(*) FROM cal_obs GROUP BY 1 ORDER BY 1").fetchall(),
        TILE_ROWS,
    )


def file_ranges(con, table):
    """Runs of file ids (first, last) holding about TRANSIT_ROWS of `table`'s rows each:
    their medians can't spill, so a batch of files at a time, as each is a file's alone."""
    return ranges(
        con.execute(f"SELECT file_id, count(*) FROM {table} GROUP BY 1 ORDER BY 1").fetchall(),
        TRANSIT_ROWS,
    )


def anchors(con, n_units):
    """Each unit's anchor offset and standard error, NaN where it has no anchor, and its
    anchor pixels and transits. The offset and transits are from rows not read lost, the
    pixels from all of them: leaving out a vessel's lost rows mustn't take its anchor, or
    with it what says those rows are lost. Rows and pixels a run of tiles at a time, and the
    transits' medians a batch of files at a time, so memory follows a batch."""
    obs = f"SELECT a.*, u.unit FROM ({ANCHOR_ROWS}) a JOIN file_units u USING (vessel, file_id)"
    # No tile: the table's columns alone.
    con.execute(f"CREATE OR REPLACE TABLE anchor_rows AS {obs}", {"lo": 0, "hi": -1})
    con.execute("CREATE OR REPLACE TABLE anchor_pixels (unit INTEGER, pixels BIGINT)")
    for lo, hi in tile_ranges(con):
        con.execute(f"INSERT INTO anchor_rows {obs}", {"lo": lo, "hi": hi})
        # A pixel is in one tile, so each run's are its own.
        con.execute(
            """INSERT INTO anchor_pixels SELECT unit, count(DISTINCT (tile_id, py, px))
            FROM anchor_rows WHERE tile_id BETWEEN $lo AND $hi GROUP BY unit""",
            {"lo": lo, "hi": hi},
        )
        release()
    con.execute("CREATE OR REPLACE TABLE anchor_files (unit INTEGER, file_id BIGINT, e FLOAT)")
    for lo, hi in file_ranges(con, "anchor_rows"):
        con.execute(
            """INSERT INTO anchor_files SELECT unit, file_id, median(e) FROM anchor_rows
            WHERE NOT lost AND file_id BETWEEN $lo AND $hi GROUP BY ALL""",
            {"lo": lo, "hi": hi},
        )
        release()
    rows = con.execute(
        """WITH g AS (SELECT unit, sum(pixels) AS pixels FROM anchor_pixels GROUP BY unit)
        -- The median of the transits' medians: one long transit counts once.
        SELECT unit, median(f.e) AS offset, count(*) AS transits, g.pixels,
          list(f.e) AS per_transit
        FROM g JOIN anchor_files f USING (unit) GROUP BY ALL"""
    ).fetchall()
    for table in ("anchor_rows", "anchor_pixels", "anchor_files"):
        con.execute(f"DROP TABLE {table}")
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
    tiles = [
        t
        for (t,) in con.execute(
            "SELECT DISTINCT tile_id FROM xrows WHERE solved ORDER BY 1"
        ).fetchall()
    ]
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
            release()
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
    a = con.execute(
        "SELECT py, px, unit, m, b FROM xrows WHERE tile_id = ? AND solved", [tile]
    ).fetchnumpy()
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


def transit_offsets(con, offset, lost=False):
    """Each transit's offset, as rows (vessel, file_id, start, offset, seabed depth) in time
    order: against the reference where it has one, elsewhere against the pixel depths of
    the units other than its own, which are also the seabed it's judged over. From its rows
    that don't read lost, or from all of them where `lost` or those are under STEP_PIXELS:
    against one offset per vessel, a sounder's real move reads lost, and it still has to
    show as a step. A transit that lost the bottom shows it the same way."""
    whole = f"{bool(lost)} OR count(*) FILTER (WHERE NOT e.lost) < {STEP_PIXELS}"
    con.register("offsets_np", {"unit": np.arange(len(offset)), "o": offset})
    # A run of tiles at a time: every row of a pixel is in its tile, and the planet's in one
    # statement spilled past 15 GB.
    transits = f"""
        WITH x AS (
          SELECT x.*, o.o FROM xrows x JOIN offsets_np o USING (unit)
          WHERE x.tile_id BETWEEN $lo AND $hi
        ),
        px AS (
          SELECT tile_id, py, px, sum(b * (m - o)) AS t, sum(b) AS w FROM x GROUP BY ALL
        ),
        others AS (
          -- Each unit's pixel depth from the other units there: all of them for a unit
          -- whose rows there all read lost, which has none in `xrows`.
          SELECT tile_id, py, px, unit,
            (px.t - coalesce(x.b * (x.m - x.o), 0)) / (px.w - coalesce(x.b, 0)) AS z
          FROM (SELECT DISTINCT tile_id, py, px, unit FROM xobs WHERE tile_id BETWEEN $lo AND $hi)
          JOIN px USING (tile_id, py, px) LEFT JOIN x USING (tile_id, py, px, unit)
          WHERE px.w > coalesce(x.b, 0)
        )
        SELECT o.vessel, o.file_id, o.t, o.m - z.z AS e, z.z AS z, o.lost
        FROM (FROM xobs WHERE tile_id BETWEEN $lo AND $hi) o
        JOIN others z USING (tile_id, py, px, unit)
        UNION ALL BY NAME {ANCHOR_ROWS}"""
    con.execute(f"CREATE OR REPLACE TABLE transit_e AS {transits}", {"lo": 0, "hi": -1})
    for lo, hi in tile_ranges(con):
        con.execute(f"INSERT INTO transit_e BY NAME {transits}", {"lo": lo, "hi": hi})
        release()
    con.unregister("offsets_np")
    rows = []
    for lo, hi in file_ranges(con, "transit_e"):
        rows += con.execute(
            f"""SELECT e.vessel, e.file_id, f.time_min AS t,
              CASE WHEN {whole} THEN median(e.e) ELSE median(e.e) FILTER (WHERE NOT e.lost) END,
              CASE WHEN {whole} THEN median(e.z) ELSE median(e.z) FILTER (WHERE NOT e.lost) END
            FROM transit_e e JOIN lake.files f USING (file_id)
            WHERE e.file_id BETWEEN $lo AND $hi GROUP BY e.vessel, e.file_id, f.time_min
            HAVING count(*) >= {STEP_PIXELS}""",
            {"lo": lo, "hi": hi},
        ).fetchall()
        release()
    con.execute("DROP TABLE transit_e")
    # In time order per vessel, as ORDER BY vessel, t, file_id would give them, nulls last.
    rows.sort(key=lambda r: (r[0], r[2] is None, r[2] or datetime.min, r[1]))
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


def without_lost_steps(con, segments):
    """`segments` without the step into a segment whose readings don't follow the seabed
    at anchor-quality pixels, which joins it to the segment before it, or after it if it's
    the first: its rows then read lost against that segment's offset, as a move's wouldn't.
    A step out of it stays."""
    if not segments:
        return segments
    names = units_for(con, segments)
    # The rows a run of tiles at a time, so the join's memory follows a run.
    con.execute("CREATE OR REPLACE TABLE step_rows (unit INTEGER, m FLOAT, depth FLOAT)")
    for lo, hi in tile_ranges(con):
        con.execute(
            """INSERT INTO step_rows SELECT u.unit, o.m, s.depth
            FROM cal_obs o JOIN file_units u USING (vessel, file_id)
            JOIN anchor_px s USING (tile_id, py, px)
            WHERE list_contains($vessels, o.vessel)
              AND o.tile_id BETWEEN $lo AND $hi AND s.tile_id BETWEEN $lo AND $hi""",
            {"vessels": list(segments), "lo": lo, "hi": hi},
        )
        release()
    lost = con.execute(
        f"""SELECT unit FROM (
          SELECT unit, regr_slope(m, depth) AS slope, stddev(depth) AS spread
          FROM step_rows GROUP BY unit
        ) WHERE spread >= {SEABED_SPREAD_M} AND slope < {FOLLOWS_SEABED}"""
    ).fetchall()
    con.execute("DROP TABLE step_rows")
    dropped = set()
    for (unit,) in lost:
        vessel, seg = names[unit]
        dropped.add((vessel, segments[vessel][max(seg - 1, 0)]))
    log.info("calibrate: %d steps into readings that don't follow the seabed", len(dropped))
    kept = {v: [t for t in starts if (v, t) not in dropped] for v, starts in segments.items()}
    return {v: starts for v, starts in kept.items() if starts}


def segments_from(series):
    """{vessel: [start time of each segment after the first]}."""
    out = {}
    for vessel, (times, offsets) in series.items():
        idx = steps(offsets)
        if idx:
            out[vessel] = [times[i] for i in idx]
    return out


def solve_without_lost(con, n_units):
    """Solve, judge each of calibration's medians lost against the offsets, and solve
    again without the lost ones while that changes which they are, for at most LOST_PASSES
    passes. Returns (offset, se, anchored component mask, anchor offset, anchor pixels,
    anchor transits)."""
    for i in range(LOST_PASSES + 1):
        crossings(con)
        anchor, anchor_se, pixels, transits = anchors(con, n_units)
        offset, se, anchored = solve(con, n_units, anchor, anchor_se)
        if i == LOST_PASSES:
            log.info("calibrate: stopped judging lost medians after %d passes", LOST_PASSES)
        if i == LOST_PASSES or not judge_lost(con, offset, anchored):
            return offset, se, anchored, anchor, pixels, transits


def judge_lost(con, offset, anchored):
    """Mark each row of `cal_obs` lost or not by `offset`, a tile at a time, so memory
    follows a tile's rows. Over the seabed `stuck_runs` judges by, the survey's or the
    crowd's where shallower, and the anchor's where that's shallower still: a reference
    that wouldn't anchor mustn't lose the rows one that would anchors. Offsets aren't yet
    known to apply, so the crowd and the rows judged take in every unit an anchor reaches.
    Rows of any other unit stay as they were. Returns how many rows changed."""
    con.register(
        "offsets_np", {"unit": np.flatnonzero(anchored), "o": np.asarray(offset)[anchored]}
    )
    con.execute(
        """CREATE OR REPLACE TABLE unit_offsets AS
        SELECT u.vessel, u.file_id, o.o FROM file_units u JOIN offsets_np o USING (unit)"""
    )
    con.unregister("offsets_np")
    changed = 0
    for (tile,) in con.execute("SELECT DISTINCT tile_id FROM cal_obs ORDER BY 1").fetchall():
        con.execute(
            f"""CREATE OR REPLACE TABLE lost_change AS
            WITH o AS (
              SELECT c.py, c.px, c.vessel, c.file_id, c.m, c.lost, u.o
              FROM cal_obs c JOIN unit_offsets u USING (vessel, file_id)
              WHERE c.tile_id = $tile
            ),
            crowd AS (
              SELECT py, px, median(z) AS z FROM (
                SELECT py, px, vessel, median(m - o) AS z FROM o GROUP BY ALL)
              GROUP BY ALL HAVING count(*) >= {CROWD_VESSELS}
            ),
            seabed AS (
              SELECT py, px, least(s.depth, a.depth, c.z) AS z
              FROM (FROM survey_px WHERE tile_id = $tile) s
              FULL JOIN (FROM anchor_px WHERE tile_id = $tile) a USING (py, px)
              FULL JOIN crowd c USING (py, px)
            ),
            judged AS (
              SELECT o.py, o.px, o.vessel, o.file_id, o.lost,
                coalesce(o.m < {LOST_BOTTOM} * (s.z + o.o) AND o.m < s.z + o.o - {LOST_MARGIN_M},
                  false) AS now
              FROM o LEFT JOIN seabed s USING (py, px)
            )
            SELECT py, px, vessel, file_id, now FROM judged WHERE now <> lost""",
            {"tile": tile},
        )
        con.execute(
            """UPDATE cal_obs c SET lost = l.now FROM lost_change l WHERE c.tile_id = $tile
            AND c.py = l.py AND c.px = l.px AND c.vessel = l.vessel
            AND c.file_id = l.file_id""",
            {"tile": tile},
        )
        changed += con.execute("SELECT count(*) FROM lost_change").fetchone()[0]
        release()
    con.execute("DROP TABLE lost_change")
    log.info("calibrate: %d medians judged lost or no longer lost", changed)
    return changed


def crossing_transits(con, n_units):
    rows = con.execute(
        "SELECT unit, count(DISTINCT file_id) FROM xobs WHERE solved AND NOT lost GROUP BY unit"
    ).fetchall()
    n = np.zeros(n_units, int)
    for unit, k in rows:
        n[unit] = k
    return n


@on_disk
def run(con, references=(), accept_losses=False) -> dict:
    """Calibrate every vessel segment and publish the offsets that moved, after sampling
    `references` (see reference.py) at pixels they haven't been sampled at."""
    if not con.execute("SELECT count(*) FROM lake.tide_stations").fetchone()[0]:
        raise RuntimeError("calibration reads tide-reduced depths; run `grid tide` first")
    tiles, reduced = reduce(con)
    sampled = reference.sample(con, references) if references else 0
    # Kept now, not at the next checkpoint: a run that fails in the solve would otherwise
    # reduce and sample the same files and pixels again.
    if (reduced or sampled) and getattr(con, "published", None) is not None:
        con.publish()
    # Pass 1: a unit per vessel, for pixel depths to find steps against.
    names = units_for(con, {})
    if not names:
        log.info("calibrate: no tide-reduced soundings to calibrate")
        return {"tiles": tiles, "reduced_files": reduced, "segments": 0}
    reference_px(con)
    first, *_ = solve_without_lost(con, len(names))
    segments = without_lost_steps(con, segments_from(series(transit_offsets(con, first))))
    # Pass 2: a unit per segment. A vessel with steps was judged by one offset across them.
    if segments:
        for lo, hi in tile_ranges(con):
            con.execute(
                """UPDATE cal_obs SET lost = false WHERE lost AND list_contains($vessels, vessel)
                AND tile_id BETWEEN $lo AND $hi""",
                {"vessels": list(segments), "lo": lo, "hi": hi},
            )
            release()
    names = units_for(con, segments)
    offset, se, anchored, anchor, pixels, transits = solve_without_lost(con, len(names))
    with step("judging transits"):
        crossed = crossing_transits(con, len(names))
        stray = outliers(con, transit_offsets(con, offset, lost=True), offset, se, anchored)
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
    with step("finding stuck runs"):
        runs = stuck_runs(con, kept, status)
    with step("publishing"):
        dirty = publish(con, rows, stray, accept_losses, runs)
    # The tide the offsets were solved against: once it changes, they are stale.
    con.execute("DELETE FROM lake.store_meta WHERE key = 'calibration_tide'")
    con.execute("INSERT INTO lake.store_meta VALUES ('calibration_tide', ?)", [cells.tides(con)])
    totals = {
        "tiles": tiles,
        "reduced_files": reduced,
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
        # The tiles of soundings a run now takes, or no longer takes. A store calibrated
        # before months were judged by tile holds months with no tile, in every tile.
        dirty = cells.stale(con, CHANGED_RUN_TILES, {}, "calibration", was_settled)
        con.execute("DROP TABLE old_runs")
        # Until the calibration these runs were found under is recorded, they're stale.
        con.execute("DELETE FROM lake.store_meta WHERE key = 'stuck_runs'")
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    # The calibration as the store holds it once committed, which can round an offset to
    # another single-precision value than numpy does. A run that stops before this leaves
    # them stale, and `grid cells` waits for `grid calibrate`.
    stored = con.execute("SELECT * FROM lake.calibration").fetchall()
    con.execute("INSERT INTO lake.store_meta VALUES ('stuck_runs', ?)", [calibrated_by(stored)])
    log.info("calibrate: %d tiles stale from stuck runs", dirty)
    with step("assigning file offsets"):
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
        *map(as_hashed, SEARCH),
        STUCK,
        FLAT,
        as_hashed(inspect.getsource(reference_px)),
        as_hashed(inspect.getsource(stuck_runs)),
        FLAT_RELIEF_M,
        ANCHOR_UNCERTAINTY_M,
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
