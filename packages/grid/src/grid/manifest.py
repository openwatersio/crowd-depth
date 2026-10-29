"""What each 1° tile's cells are built from, so a daily run rebuilds only the tiles whose
inputs moved. These fingerprints are each tile's own: a tile's surface also reads its
neighbors' edges, so whatever decides that a surface is current has to combine its
neighbors' fingerprints with its own.

A tile's fingerprint covers everything its cells read (catalog's `corrected_points_in`):

- its files' key, version, status, content and soundings in the tile, through
  `lake.file_tiles`;
- the QC version of the batches those soundings came in;
- its files' calibrated offsets, and the stuck runs that touch it;
- the Open Waters files of a NOAA file's vessel that overlap it in time, which dedupe rule 5
  can take that NOAA file's soundings for;
- its tide cells' stations and their distances, and those stations' levels on the days its
  files cover;
- the QC and grid versions, and the code cells are built with (`cells.CODE`).

Inputs that change none of these, an ETag alone or a level on a day none of the tile's files
covers, leave the fingerprint as it was.
"""

import hashlib
import logging

from . import cells
from .qc import QC_VERSION

log = logging.getLogger(__name__)


INCOMPLETE = """
SELECT file_id FROM lake.files f
LEFT JOIN (SELECT file_id, sum(n) AS n FROM lake.file_tiles GROUP BY 1) t USING (file_id)
WHERE f.has_points AND coalesce(t.n, 0) <> f.point_count
"""


def ensure_file_tiles(con) -> int:
    """Bring `lake.file_tiles` level with the points: drop the rows of files that no longer
    hold points, and fill again any file holding points whose rows don't add up to them. A
    store from before the table, or one an older build ingested into or moved points in,
    gets here. Call it outside a transaction. Returns how many files it filled."""
    con.execute(f"CREATE OR REPLACE TEMP TABLE missing_tiles AS {INCOMPLETE}")
    try:
        [(n,)] = con.execute("SELECT count(*) FROM missing_tiles").fetchall()
        # A partition at a time, so memory follows a partition; in one transaction, so a file
        # crossing partitions is never left half filled.
        # ponytail: a stopped planet backfill starts over; mark partitions done if it's slow
        con.execute("BEGIN")
        try:
            con.execute(
                """DELETE FROM lake.file_tiles WHERE file_id IN (SELECT file_id FROM missing_tiles)
                OR file_id IN (SELECT file_id FROM lake.files WHERE NOT has_points)"""
            )
            partitions = (
                [
                    c
                    for (c,) in con.execute(
                        "SELECT DISTINCT cell_id FROM lake.points ORDER BY 1"
                    ).fetchall()
                ]
                if n
                else []
            )
            for cell in partitions:
                con.execute(
                    """INSERT INTO lake.file_tiles
                    SELECT file_id, tile_id, cell_id, batch_id, count(*) FROM lake.points
                    WHERE cell_id = ? AND file_id IN (SELECT file_id FROM missing_tiles)
                    GROUP BY ALL""",
                    [cell],
                )
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
    finally:
        con.execute("DROP TABLE missing_tiles")
    # Filled from the points themselves: a file whose points still don't add up to its
    # count has a fault no refill mends, and stays so until someone looks.
    still = [f for (f,) in con.execute(f"{INCOMPLETE} ORDER BY 1 LIMIT 5").fetchall()]
    if still:
        raise RuntimeError(f"files whose points don't match their point_count: {still}")
    if n:
        log.info("manifest: filled file_tiles for %d files", n)
    return n


# Each part sums hashes of rows per tile, as cells.inputs does for the whole store, so the
# order rows come in doesn't matter.
FINGERPRINT_PARTS = """
WITH ft AS (
  -- One row per file and tile, however many batches its soundings came in.
  SELECT t.tile_id, t.n, f.* FROM (
    SELECT tile_id, file_id, sum(n) AS n FROM lake.file_tiles GROUP BY ALL
  ) t JOIN lake.files f USING (file_id)
),
files AS (
  SELECT tile_id, sum(hash(file_id, key, version, status, content_hash, n)::HUGEINT) AS h,
    sum(n) FILTER (WHERE status = 'active') AS active
  FROM ft GROUP BY 1
),
qc AS (
  SELECT t.tile_id, sum(hash(t.batch_id, b.qc_version)::HUGEINT) AS h
  FROM (SELECT DISTINCT tile_id, batch_id FROM lake.file_tiles) t
  LEFT JOIN lake.qc_batches b USING (batch_id) GROUP BY 1
),
offsets AS (
  SELECT ft.tile_id, sum(hash(o.file_id, o.vessel, o.offset_m, o.se_m, o.excluded,
    coalesce(o.lost_bottom, false))::HUGEINT) AS h
  FROM ft JOIN lake.file_offsets o USING (file_id) GROUP BY 1
),
runs AS (
  SELECT ft.tile_id, sum(hash(r.content_hash, r.vessel, r.tile_id, r.t_start, r.t_end)::HUGEINT)
    AS h
  FROM ft JOIN lake.lost_runs r
    ON r.content_hash = ft.content_hash AND (r.tile_id IS NULL OR r.tile_id = ft.tile_id)
  GROUP BY 1
),
copies AS (
  -- Rule 5: an Open Waters file of a NOAA file's vessel, over its time, takes its soundings.
  SELECT ft.tile_id, sum(hash(o.file_id, o.status, o.time_min, o.time_max)::HUGEINT) AS h
  FROM ft JOIN lake.files o ON o.source = 'openwaters' AND ft.source = 'noaa'
    AND o.vessel = ft.vessel
    -- Widened to whole seconds, as the dedupe widens them (catalog.ACTIVE).
    AND date_trunc('second', o.time_min) <= ft.time_max
    AND date_trunc('second', o.time_max) + INTERVAL 1 SECOND > ft.time_min
  GROUP BY 1
),
stations AS (
  SELECT tile_id, sum(hash(tide_cell, station_id, km)::HUGEINT) AS h FROM lake.tide_cells
  GROUP BY 1
),
days AS (
  -- The days the tile's active files cover, by the stations its tide cells take levels from.
  SELECT DISTINCT d.tile_id, s.station_id, d.day FROM (
    SELECT tile_id, unnest(generate_series(time_min::DATE, time_max::DATE, INTERVAL 1 DAY))::DATE
      AS day
    FROM ft WHERE status = 'active' AND time_min IS NOT NULL AND time_max IS NOT NULL
  ) d JOIN (SELECT DISTINCT tile_id, station_id FROM lake.tide_cells WHERE station_id IS NOT NULL) s
    USING (tile_id)
),
levels AS (
  SELECT station_id, slot::DATE AS day,
    sum(hash(station_id, slot, level, slope, sigma)::HUGEINT) AS h
  FROM lake.tide_levels GROUP BY ALL
),
tide AS (
  SELECT d.tile_id, sum(l.h) AS h FROM days d JOIN levels l USING (station_id, day) GROUP BY 1
)
SELECT tile_id, coalesce(files.active, 0) AS active,
  concat_ws(
    '/', files.h, coalesce(qc.h, 0), coalesce(offsets.h, 0), coalesce(runs.h, 0),
    coalesce(copies.h, 0), coalesce(stations.h, 0), coalesce(tide.h, 0)
  ) AS parts
FROM files
LEFT JOIN qc USING (tile_id) LEFT JOIN offsets USING (tile_id) LEFT JOIN runs USING (tile_id)
LEFT JOIN copies USING (tile_id) LEFT JOIN stations USING (tile_id) LEFT JOIN tide USING (tile_id)
ORDER BY tile_id
"""


def fingerprints(con) -> dict[int, tuple[str, int]]:
    """{tile: (fingerprint, active soundings)} for every tile any file has held soundings in,
    those with none active left included, so their outputs can be removed.

    The count is of active files' rows before dedupe, read from file_tiles rather than the
    points: a tile whose soundings rules 4 and 5 all set aside still counts them. Its
    fingerprint moves with the files that set them aside, so it is rebuilt, with no cells."""
    incomplete = [f for (f,) in con.execute(f"{INCOMPLETE} ORDER BY 1 LIMIT 5").fetchall()]
    if incomplete:
        raise RuntimeError(
            f"file_tiles doesn't cover the points of files {incomplete}; run ensure_file_tiles"
        )
    constants = f"{QC_VERSION}/{cells.GRID_VERSION}/{cells.CODE}"
    return {
        tile: (hashlib.sha256(f"{constants}/{parts}".encode()).hexdigest()[:16], active)
        for tile, active, parts in con.execute(FINGERPRINT_PARTS).fetchall()
    }
