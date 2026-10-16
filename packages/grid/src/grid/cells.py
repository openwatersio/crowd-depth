"""Grid cells: shoal-biased statistics on a variable-resolution grid, one 10° partition at a time.

The base grid is 1/3″ of latitude (about 10 m). Columns are `k` base steps wide so
cells stay roughly square; `k` divides 1,200, so 1″ (3×3 base) and 3″ (9×9 base)
cells tile each 1° tile exactly. A cell's `level` is its size in base steps: 1, 3
or 9. Where two or more vessels sounded a 1″ cell, its base cells publish on their
own; a lone track is aggregated to 1″ or 3″, so one vessel's track alone never
publishes finer than its positions hold.
"""

import logging
import math

from .catalog import BASE_ROW
from .qc import MAX_DEPTH_M, QC_VERSION, TRACK_REASONS

log = logging.getLogger(__name__)

GRID_VERSION = 1
BATCH_POINTS = 5_000_000
BASE = 10_800  # base rows per 1° tile
SHOAL_QUANTILE = 0.10
MIN_VESSELS = 2
CELL_REASONS = ["cell_deep", "cell_shoal", "cell_confirmed", "consensus_deep", "consensus_shoal"]
# A sounding of the same vessel this far apart in time is another pass.
OTHER_PASS = "4 hours"
DIVISORS = [d for d in range(1, 1201) if 1200 % d == 0]


def k_for(lat0: int) -> int:
    """Column width in base steps for the 1° tile whose southern edge is lat0."""
    want = max(1, round(1 / math.cos(math.radians(lat0 + 0.5))))
    return next(d for d in DIVISORS if d >= want)


# k for each tile row, indexed by lat0 + 91 (SQL lists are 1-based).
K_LIST = "[" + ",".join(str(k_for(lat0)) for lat0 in range(-90, 90)) + "]"


def tolerance(d: str) -> str:
    """CATZOC C depth tolerance: provisional vertical uncertainty until corrections exist."""
    return f"(2 + 0.05 * {d})"


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
# Soundings a cell's median, spread and 10th percentile are taken from, at most. These
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
CONFIRM = f"""
CREATE OR REPLACE TEMP TABLE confirmed AS
WITH shoals AS (
  SELECT point_id, tile_id, level, cr, cc, vessel, time,
    floor(ln(d + 40) / {math.log(1.05)})::BIGINT AS bin
  FROM classed WHERE outlier = 'shoal'
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
# soundings QC accepted, and its shoalest sounding, unconfirmed ones included. A
# sounding is judged against the other vessels' votes in the 3x3 blocks around its own,
# each vessel once, wherever two or more voted. Deeper than their consensus by more
# than the tolerance, it's rejected. Shoaler by more than that, it's rejected only when
# three or more of them agree with the consensus and none read anything within a shoal
# tolerance of it; otherwise it goes on to the cell's own shoal confirmation. The
# tolerance is the larger of 2 m + 5% of the consensus and three times the spread of
# the votes, so it widens on slopes, where vessels a block apart honestly disagree.
# A vessel's vote is the median of a fixed sample, as cells' are, so one moored in a
# block for a year costs fixed memory; a vote of the others is the median of at most 9.
# ponytail: neighbors stop at tile edges; look across them if a tile's edge rows matter
CONSENSUS = f"""
CREATE OR REPLACE TEMP TABLE votes AS
SELECT tile_id, br, bc, vessel, median(d) FILTER (WHERE flag IS NULL AND keep) AS med,
  min(d) AS shoalest
FROM {sample("unit_points", ["tile_id", "br", "bc", "vessel"], "keep")} GROUP BY ALL;

CREATE OR REPLACE TEMP TABLE consensus AS
WITH others AS (
  SELECT a.tile_id, a.br, a.bc, a.vessel, b.vessel AS other,
    median(b.med) AS med, min(b.shoalest) AS shoalest
  FROM (SELECT DISTINCT tile_id, br, bc, vessel FROM votes) a JOIN votes b
    ON b.tile_id = a.tile_id AND b.br BETWEEN a.br - 1 AND a.br + 1
    AND b.bc BETWEEN a.bc - 1 AND a.bc + 1 AND b.vessel <> a.vessel
  GROUP BY ALL
)
SELECT tile_id, br, bc, vessel, median(med) AS m, coalesce(mad(med), 0) AS spread,
  list(med) FILTER (WHERE med IS NOT NULL) AS meds, min(shoalest) AS shoalest
FROM others GROUP BY ALL HAVING count(med) >= 2;
DROP TABLE votes;

CREATE OR REPLACE TEMP TABLE consensus_rejects AS
WITH judged AS (
  SELECT p.point_id, p.d, c.m, c.meds, c.shoalest,
    greatest(2 + 0.05 * c.m, 3 * 1.4826 * c.spread) AS tol
  FROM unit_points p JOIN consensus c
    ON c.tile_id = p.tile_id AND c.br = p.br AND c.bc = p.bc AND c.vessel = p.vessel
  WHERE p.r >= $rlo AND p.r < $rhi
)
SELECT point_id, CASE WHEN d > m THEN 'consensus_deep' ELSE 'consensus_shoal' END AS reason
FROM judged
WHERE d > m + tol
  OR (d < m - tol AND len(list_filter(meds, x -> abs(x - m) <= tol)) >= {DISPROVE}
    AND shoalest > d + 2 + 0.05 * d);
DROP TABLE consensus;
"""

CLASSIFY = f"""
CREATE OR REPLACE TEMP TABLE unit_points AS
WITH flags AS (
  SELECT point_id, flag FROM lake.qc_flags
  WHERE cell_id = $partition AND qc_version = {QC_VERSION} AND list_contains({TRACK_REASONS}, reason)
    AND flag IN ('reject', 'unconfirmed')
),
pts AS (
  SELECT a.point_id, a.tile_id, a.cell_id, a.unique_id AS vessel, a.time, a.lon, a.lat,
    a.depth_raw AS d, f.flag,
    a.tile_id // 360 - 90 AS lat0, a.tile_id % 360 - 180 AS lon0,
    {K_LIST}[a.tile_id // 360 - 90 + 91] AS k
  -- The unit's rows and a 3″ row either side, which consensus reads.
  FROM active_points_in($partition, $tiles, $rlo - 9, $rhi + 9) a LEFT JOIN flags f USING (point_id)
  WHERE f.flag IS DISTINCT FROM 'reject'
    -- QC rejects these too; cells never trust that QC saw every point.
    AND a.depth_raw > 0 AND a.depth_raw <= {MAX_DEPTH_M}
),
idx AS (
  SELECT *,
    least(floor((lat - lat0) * {BASE})::INTEGER, {BASE - 1}) AS r,
    least(floor((lon - lon0) * {BASE} / k)::INTEGER, {BASE} // k - 1) AS c
  FROM pts
)
SELECT *, r // 9 AS br, c // 9 AS bc FROM idx;

{CONSENSUS}

CREATE OR REPLACE TEMP TABLE unit_rows AS
SELECT * EXCLUDE (br, bc) FROM unit_points WHERE r >= $rlo AND r < $rhi
  AND point_id NOT IN (SELECT point_id FROM consensus_rejects);
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
    k.flag IS NOT DISTINCT FROM 'unconfirmed' AS from_track
  FROM keyed k LEFT JOIN robust r USING (tile_id, level, cr, cc)
)
SELECT * FROM classified;

{CONFIRM}
DROP TABLE keyed;

CREATE OR REPLACE TEMP TABLE kept AS
SELECT * EXCLUDE (level, cr, cc) FROM classed
WHERE outlier IS NULL OR point_id IN (SELECT point_id FROM confirmed);

-- Levels again from accepted soundings only, so a vessel whose soundings were all
-- rejected can't raise another vessel's track to a finer level.
{levels("kept", "relevelled")}
DROP TABLE kept;

CREATE OR REPLACE TEMP TABLE by_cell AS SELECT * FROM {sample("relevelled", CELL, "keep_cell")};

DROP TABLE relevelled;

CREATE OR REPLACE TEMP TABLE accepted AS
SELECT * FROM {sample("by_cell", CELL + ["r", "c"], "keep_base")};
DROP TABLE by_cell;

-- Aggregates first, as small tables, so the join placing each cell's sounding is built
-- on them: DuckDB can't spill a hash join's table, so it must never be the points.
CREATE OR REPLACE TEMP TABLE children AS
-- A confirmed shoal always sets the depth, however many deeper soundings surround it.
SELECT tile_id, level, cr, cc,
  least(quantile_disc(d, {SHOAL_QUANTILE}) FILTER (WHERE keep_base),
    min(d) FILTER (WHERE outlier = 'shoal')) AS depth
FROM accepted GROUP BY tile_id, level, cr, cc, r, c;

CREATE OR REPLACE TEMP TABLE stats AS
-- An aggregated cell keeps its shoalest base cell, so aggregation never hides an accepted shoal.
SELECT * FROM (
  SELECT tile_id, level, cr, cc, any_value(cell_id) AS cell_id, any_value(lat0) AS lat0,
    any_value(lon0) AS lon0, any_value(k) AS k, median(d) FILTER (WHERE keep_cell) AS median,
    coalesce(mad(d) FILTER (WHERE keep_cell), 0) AS mad, min(d) AS min, max(d) AS max,
    count(*) AS count, count(DISTINCT vessel) AS vessels, min(time) AS first, max(time) AS last
  FROM accepted GROUP BY tile_id, level, cr, cc
) JOIN (SELECT tile_id, level, cr, cc, min(depth) AS depth FROM children GROUP BY ALL)
  USING (tile_id, level, cr, cc);

-- The cell's depth is an actual sounding; SOUNDG sits at that sounding's position.
CREATE OR REPLACE TEMP TABLE placed AS
SELECT a.tile_id, a.level, a.cr, a.cc, arg_min({{'lon': a.lon, 'lat': a.lat}}, a.time) AS at
FROM accepted a JOIN stats s USING (tile_id, level, cr, cc) WHERE a.d = s.depth GROUP BY ALL;
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
  greatest({tolerance("s.depth")}, 1.96 * 1.4826 * s.mad) AS tvu,
  CASE WHEN s.vessels >= {MIN_VESSELS} THEN 'multi' ELSE 'single' END AS kind, 5 AS zoc,
  p.at.lon AS depth_lon, p.at.lat AS depth_lat, s.cell_id, {GRID_VERSION} AS grid_version
FROM stats s JOIN placed p USING (tile_id, level, cr, cc)
"""

CELL_FLAGS = """
SELECT point_id, 'reject' AS flag, 'cell_deep' AS reason FROM classed WHERE outlier = 'deep'
UNION ALL
SELECT point_id, 'reject', reason FROM consensus_rejects
UNION ALL
SELECT point_id, 'unconfirmed', 'cell_shoal' FROM classed
WHERE outlier = 'shoal' AND NOT from_track AND point_id NOT IN (SELECT point_id FROM confirmed)
UNION ALL
SELECT point_id, 'confirmed', 'cell_confirmed' FROM classed
WHERE from_track AND (outlier IS NULL OR point_id IN (SELECT point_id FROM confirmed))
"""


# Base cells holding an active sounding that is still an unconfirmed shoal: neither
# confirmed nor rejected since. The soundings are the deduplicated ones the cells are
# built from, so a copy dedupe dropped can't hold a cell open. The unit's rows and
# one row past each edge, which holes read.
SHOAL_CELLS = f"""
CREATE OR REPLACE TEMP TABLE shoal_cells AS
SELECT DISTINCT p.tile_id, {BASE_ROW} AS r,
  least(floor((p.lon - (p.tile_id % 360 - 180)) * {BASE} / {K_LIST}[p.tile_id // 360 - 90 + 91])
    ::INTEGER, {BASE} // {K_LIST}[p.tile_id // 360 - 90 + 91] - 1) AS c
FROM active_points_in($partition, $tiles, $rlo - 1, $rhi + 1) p JOIN lake.qc_flags q USING (point_id)
WHERE q.cell_id = $partition AND q.flag = 'unconfirmed' AND q.qc_version = {QC_VERSION}
  AND NOT EXISTS (SELECT 1 FROM lake.qc_flags k WHERE k.cell_id = $partition
    AND k.point_id = q.point_id AND k.flag IN ('confirmed', 'reject') AND k.qc_version = {QC_VERSION})
"""

# Base cells bracketed by published cells on opposite sides (row, column or diagonal),
# filled with the shoalest bracketing cell. Coarse cells cover their whole area.
# Filled cells never fill others, so nothing grows outward from a track. Within a
# tile only. Reads the temp table `measured`.
HOLES = f"""
WITH ring AS (
  -- Holes can only be in the ring of base cells around a published cell.
  SELECT DISTINCT m.tile_id, m.cell_id, m."row" * m.level + dr AS r, m.col * m.level + dc AS c,
    {K_LIST}[m.tile_id // 360 - 90 + 91] AS k
  FROM measured m, range(-1, 10) a(dr), range(-1, 10) b(dc)
  WHERE dr <= m.level AND dc <= m.level AND (dr IN (-1, m.level) OR dc IN (-1, m.level))
),
inside AS (
  -- A base cell holding an unconfirmed shoal isn't empty: filling it would show the
  -- water over that shoal as deeper than it was measured.
  SELECT * FROM ring WHERE r >= $rlo AND r < $rhi AND c >= 0 AND c < {BASE} // k
    AND NOT EXISTS (SELECT 1 FROM shoal_cells s
      WHERE s.tile_id = ring.tile_id AND s.r = ring.r AND s.c = ring.c)
),
offsets AS (
  -- Pair 0 is the candidate itself; pairs 1 to 4 are opposite neighbors.
  SELECT * FROM (VALUES (0, 0, 0), (1, -1, 0), (1, 1, 0), (2, 0, -1), (2, 0, 1),
    (3, -1, -1), (3, 1, 1), (4, -1, 1), (4, 1, -1)) o(pair, dr, dc)
),
looks AS (
  SELECT i.*, o.pair, i.r + o.dr AS nr, i.c + o.dc AS nc FROM inside i, offsets o
),
found AS (
  SELECT l.*, coalesce(m1.depth, m3.depth, m9.depth) AS depth,
    coalesce(m1.tvu, m3.tvu, m9.tvu) AS tvu
  FROM looks l
  LEFT JOIN measured m1 ON m1.tile_id = l.tile_id AND m1.level = 1
    AND m1."row" = l.nr AND m1.col = l.nc
  LEFT JOIN measured m3 ON m3.tile_id = l.tile_id AND m3.level = 3
    AND m3."row" = l.nr // 3 AND m3.col = l.nc // 3
  LEFT JOIN measured m9 ON m9.tile_id = l.tile_id AND m9.level = 9
    AND m9."row" = l.nr // 9 AND m9.col = l.nc // 9
  -- Integer division truncates toward zero, so a negative index would find row 0.
  WHERE l.nr >= 0 AND l.nc >= 0
),
bracketed AS (
  SELECT tile_id, cell_id, r, c, k, pair, min(depth) AS depth, max(tvu) AS tvu
  FROM found WHERE pair > 0 AND depth IS NOT NULL
  GROUP BY ALL HAVING count(*) = 2
),
filled AS (
  SELECT tile_id, any_value(cell_id) AS cell_id, r, c, any_value(k) AS k,
    min(depth) AS depth, max(tvu) AS tvu
  FROM bracketed b
  WHERE NOT EXISTS (SELECT 1 FROM found f WHERE f.pair = 0 AND f.depth IS NOT NULL
    AND f.tile_id = b.tile_id AND f.r = b.r AND f.c = b.c)
  GROUP BY tile_id, r, c
)
SELECT tile_id, 1 AS level, r AS "row", c AS col,
  tile_id % 360 - 180 + c * k / {BASE} AS lon_min, tile_id // 360 - 90 + r / {BASE} AS lat_min,
  tile_id % 360 - 180 + (c + 1) * k / {BASE} AS lon_max,
  tile_id // 360 - 90 + (r + 1) / {BASE} AS lat_max,
  depth, 0 AS count, 0 AS vessels, tvu, 'filled' AS kind, 5 AS zoc, cell_id,
  {GRID_VERSION} AS grid_version
FROM filled
"""


def units(con, partition: int, tiles: list[int]) -> list[tuple[list[int], int, int]]:
    """A partition's work in units of about BATCH_POINTS points: (tiles, first base row, end row).

    Small tiles are grouped whole. A denser tile is split into bands of 3″ rows (9 base
    rows), so every cell, and the levels and outliers judged within it, falls in one band.
    """
    rows = con.execute(
        f"""SELECT tile_id, {BASE_ROW} // 9 AS r9, count(*) AS n
        FROM lake.points p
        WHERE cell_id = $partition AND (len($tiles) = 0 OR list_contains($tiles, tile_id))
        GROUP BY ALL ORDER BY ALL""",
        {"partition": partition, "tiles": tiles},
    ).fetchall()
    by_tile = {}
    for tile, r9, n in rows:
        by_tile.setdefault(tile, []).append((r9, n))
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
        for r9, n in bands:
            # ponytail: one 3″ row over the budget still runs alone
            if size_band and size_band + n > BATCH_POINTS:
                result.append(([tile], start * 9, r9 * 9))
                start, size_band = r9, 0
            size_band += n
        result.append(([tile], start * 9, BASE))
    if group:
        result.append((group, 0, BASE))
    return result


def build(con, tiles: list[int] | None = None) -> dict:
    """Rebuild cells (and cell-level QC flags) for the given tiles, or every tile with points.

    Measured cells first, unit by unit; then holes, which read the measured cells one
    row past each unit's edges, so a band's edge is filled the same as its middle.
    """
    tiles = tiles or []
    partitions = [
        p
        for (p,) in con.execute(
            """SELECT DISTINCT cell_id FROM lake.points
            WHERE len($tiles) = 0 OR list_contains($tiles, tile_id) ORDER BY 1""",
            {"tiles": tiles},
        ).fetchall()
    ]
    work = [(p, *unit) for p in partitions for unit in units(con, p, tiles)]
    totals = {"units": len(work), "cells": 0, "filled": 0}
    scope = """cell_id = $partition AND list_contains($tiles, tile_id)
      AND "row" * level >= $rlo AND "row" * level < $rhi"""
    for partition, unit_tiles, rlo, rhi in work:
        params = {"partition": partition, "tiles": unit_tiles, "rlo": rlo, "rhi": rhi}
        # Each step commits on its own, so a replaced or dropped table's space is freed
        # at once; only the writes to the store share a transaction.
        for statement in filter(str.strip, CLASSIFY.split(";\n")):
            # DuckDB refuses parameters a statement doesn't use.
            con.execute(statement, {k: v for k, v in params.items() if f"${k}" in statement})
        con.execute("BEGIN")
        con.execute(f"DELETE FROM lake.cells WHERE {scope}", params)
        con.execute(
            f"""DELETE FROM lake.qc_flags WHERE cell_id = $partition AND qc_version = {QC_VERSION}
            AND list_contains({CELL_REASONS}, reason) AND point_id IN (
              SELECT point_id FROM lake.points p
              WHERE cell_id = $partition AND list_contains($tiles, tile_id)
                AND {BASE_ROW} BETWEEN $rlo AND $rhi - 1)""",
            params,
        )
        [(inserted,)] = con.execute(
            f"""INSERT INTO lake.cells BY NAME
            SELECT * FROM ({CELLS}) ORDER BY tile_id, level, "row", col"""
        ).fetchall()
        con.execute(
            f"""INSERT INTO lake.qc_flags BY NAME
            SELECT q.*, $partition::SMALLINT AS cell_id, {QC_VERSION} AS qc_version
            FROM ({CELL_FLAGS}) q""",
            {"partition": partition},
        )
        totals["cells"] += inserted
        con.execute("COMMIT")
    for partition, unit_tiles, rlo, rhi in work:
        params = {"partition": partition, "tiles": unit_tiles, "rlo": rlo, "rhi": rhi}
        con.execute("BEGIN")
        con.execute(
            """CREATE OR REPLACE TEMP TABLE measured AS SELECT * FROM lake.cells
            WHERE cell_id = $partition AND list_contains($tiles, tile_id) AND kind <> 'filled'
              AND ("row" + 1) * level >= $rlo AND "row" * level <= $rhi""",
            params,
        )
        con.execute(SHOAL_CELLS, params)
        con.execute(f"CREATE OR REPLACE TEMP TABLE filled AS {HOLES}", {"rlo": rlo, "rhi": rhi})
        con.execute(
            """INSERT INTO lake.cells BY NAME SELECT * FROM filled ORDER BY tile_id, "row", col"""
        )
        totals["filled"] += con.execute("SELECT count(*) FROM filled").fetchone()[0]
        con.execute("COMMIT")
    log.info("cells: %s", totals)
    return totals
