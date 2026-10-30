"""The DuckLake catalog: one writer at a time, a renewed lock, and a conditionally moved pointer."""

import json
import logging
import os
import socket
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import duckdb
from botocore.exceptions import BotoCoreError, ClientError

from .definitions import CELLS, STATISTIC, TIDE
from .objects import Conflict, LocalObjects
from .sources import literal

log = logging.getLogger(__name__)

LOCK = "catalog/lock"
MEMORY_LIMIT = "4GB"
RETAIN = timedelta(days=7)
# A long run publishes its catalog at the first break between units of work past this
# many seconds since it last did, so a failure later keeps what it had done.
CHECKPOINT_SECONDS = 15 * 60
# R2 drops the odd connection over a run of hours: retry eight times, waiting 1 s and
# doubling (about four minutes of waits, more with timeouts), rather than DuckDB's
# default of three tries over two seconds.
HTTP_RETRIES = [
    "SET http_retries = 8",
    "SET http_retry_wait_ms = 1000",
    "SET http_retry_backoff = 2",
]
POINTER = "catalog/current"

SCHEMA = """
CREATE TABLE IF NOT EXISTS lake.files (
  file_id BIGINT, source VARCHAR, key VARCHAR, version INTEGER, file_uuid VARCHAR, vessel VARCHAR,
  etag VARCHAR, content_hash VARCHAR, arrival TIMESTAMP, ingested TIMESTAMP,
  time_min TIMESTAMP, time_max TIMESTAMP, point_count BIGINT, has_points BOOLEAN,
  status VARCHAR, reason VARCHAR, superseded_by BIGINT
);
CREATE TABLE IF NOT EXISTS lake.points (
  file_id BIGINT, "row" INTEGER, unique_id VARCHAR, platform VARCHAR, provider VARCHAR,
  time TIMESTAMP, time_raw VARCHAR, lon DOUBLE, lat DOUBLE, depth_raw FLOAT,
  tile_id INTEGER, cell_id SMALLINT, batch_id BIGINT
);
CREATE TABLE IF NOT EXISTS lake.submission_meta (
  file_id BIGINT, depth_reference VARCHAR, position_reference VARCHAR, sounder VARCHAR,
  sounder_position DOUBLE[], gnss_position DOUBLE[], draft DOUBLE, logger_version VARCHAR,
  noaa_response VARCHAR, csb VARCHAR
);
CREATE TABLE IF NOT EXISTS lake.withdrawal_holds (
  source VARCHAR, key VARCHAR, seen INTEGER, confirmed BOOLEAN
);
CREATE TABLE IF NOT EXISTS lake.qc_batches (batch_id BIGINT, qc_version INTEGER);
-- Each file's soundings per tile, and the batch they came in, so a tile's files are found
-- without reading points sorted by tile for a file_id.
CREATE TABLE IF NOT EXISTS lake.file_tiles (
  file_id BIGINT, tile_id INTEGER, cell_id SMALLINT, batch_id BIGINT, n BIGINT
);
CREATE TABLE IF NOT EXISTS lake.store_meta (key VARCHAR, value VARCHAR);
-- Tiles whose cells are built, the inputs fingerprint they were built from and a digest
-- of the cells, so a build that stopped partway resumes where it was.
CREATE TABLE IF NOT EXISTS lake.cells_built (tile_id INTEGER, inputs VARCHAR, digest VARCHAR);
-- A flag's sounding is its point_id (POINT_ID), with its tile so a tile's flags read alone.
CREATE TABLE IF NOT EXISTS lake.qc_flags (
  point_id BIGINT, flag VARCHAR, reason VARCHAR, qc_version INTEGER, cell_id SMALLINT,
  tile_id INTEGER
);
CREATE TABLE IF NOT EXISTS lake.cells (
  tile_id INTEGER, level TINYINT, "row" INTEGER, col INTEGER,
  lon_min DOUBLE, lat_min DOUBLE, lon_max DOUBLE, lat_max DOUBLE,
  depth FLOAT, median FLOAT, mad FLOAT, min FLOAT, max FLOAT, count INTEGER, vessels INTEGER,
  first DATE, last DATE, tvu FLOAT, kind VARCHAR, zoc TINYINT,
  depth_lon DOUBLE, depth_lat DOUBLE, cell_id SMALLINT, grid_version INTEGER
);
-- Active soundings still unconfirmed shoals after the cells build, which SOUNDG
-- publishes flagged; "row" is the base row within the tile.
CREATE TABLE IF NOT EXISTS lake.shoals (
  tile_id INTEGER, "row" INTEGER, lon DOUBLE, lat DOUBLE, depth FLOAT, cell_id SMALLINT
);
-- Corrections, derived from the points and never written over depth_raw. Tide: the
-- stations a tide cell (TIDE_CELL) takes its level from, and each station's level
-- above its chart datum per half hour, with its slope to the next slot.
CREATE TABLE IF NOT EXISTS lake.tide_stations (
  station_id INTEGER, station VARCHAR, lon DOUBLE, lat DOUBLE, chart_datum VARCHAR,
  gauge VARCHAR, gauge_km FLOAT, license VARCHAR, attribution VARCHAR
);
CREATE TABLE IF NOT EXISTS lake.tide_cells (tide_cell BIGINT, tile_id INTEGER, station_id INTEGER, km FLOAT);
CREATE TABLE IF NOT EXISTS lake.tide_levels (
  station_id INTEGER, slot TIMESTAMP, level FLOAT, slope FLOAT, sigma FLOAT, method VARCHAR
);
-- CO-OPS observed minus predicted water level per gauge, and when each gauge month was
-- fetched: a month is final once fetched well after its end.
CREATE TABLE IF NOT EXISTS lake.tide_residuals (gauge VARCHAR, time TIMESTAMP, residual FLOAT);
CREATE TABLE IF NOT EXISTS lake.tide_residual_months (gauge VARCHAR, month DATE, fetched DATE);
-- A surveyed reference sampled at a calibration pixel (two base rows by two base
-- columns of a tile): depth below chart datum, relief within about 20 m, uncertainty.
CREATE TABLE IF NOT EXISTS lake.reference_pixels (
  tile_id INTEGER, py INTEGER, px INTEGER, depth FLOAT, relief FLOAT, uncertainty FLOAT,
  source VARCHAR
);
-- Vertical offset per vessel step segment (negative reads shallow), and the offset of
-- each file whose segment is calibrated, which is what the grid applies.
CREATE TABLE IF NOT EXISTS lake.calibration (
  vessel VARCHAR, segment INTEGER, t_start TIMESTAMP, t_end TIMESTAMP, offset_m FLOAT,
  se_m FLOAT, status VARCHAR, anchor_pixels INTEGER, anchor_transits INTEGER,
  crossing_transits INTEGER
);
-- Transits that disagree with their segment by more than a step, left uncalibrated.
CREATE TABLE IF NOT EXISTS lake.calibration_outliers (
  file_id BIGINT, vessel VARCHAR, transit_m FLOAT, segment_m FLOAT, content_hash VARCHAR,
  seabed_m FLOAT
);
CREATE TABLE IF NOT EXISTS lake.file_offsets (
  file_id BIGINT, vessel VARCHAR, offset_m FLOAT, se_m FLOAT, excluded BOOLEAN,
  lost_bottom BOOLEAN
);
-- Runs of a file's soundings whose sounder lost the bottom, in one tile or, with no tile,
-- in all of them; by content, as ingest may move the soundings to another file.
CREATE TABLE IF NOT EXISTS lake.lost_runs (
  content_hash VARCHAR, vessel VARCHAR, tile_id INTEGER, t_start TIMESTAMP, t_end TIMESTAMP
);
-- Tiles whose cells a correction change has made stale, until `cells --changed` rebuilds them.
CREATE TABLE IF NOT EXISTS lake.tile_changes (tile_id INTEGER, reason VARCHAR, changed TIMESTAMP);
"""

# Columns added to tables after stores were first built with them.
MIGRATIONS = """
ALTER TABLE lake.cells ADD COLUMN IF NOT EXISTS tided INTEGER;
ALTER TABLE lake.cells ADD COLUMN IF NOT EXISTS calibrated INTEGER;
ALTER TABLE lake.cells ADD COLUMN IF NOT EXISTS sigma FLOAT;
ALTER TABLE lake.calibration_outliers ADD COLUMN IF NOT EXISTS content_hash VARCHAR;
ALTER TABLE lake.tide_stations ADD COLUMN IF NOT EXISTS unpredictable BOOLEAN;
ALTER TABLE lake.file_offsets ADD COLUMN IF NOT EXISTS lost_bottom BOOLEAN;
ALTER TABLE lake.calibration_outliers ADD COLUMN IF NOT EXISTS seabed_m FLOAT;
"""

# A corrected depth past this is no drying height but a correction gone wrong; cells, the
# surface and the overlay's drying band stop here.
MIN_DEPTH_M = -30

# The 0.02° cell (about 2 km) that picks a sounding's tide station, counted within the
# sounding's own 1° tile, so a point on a tile's edge or the antimeridian is in a cell
# of its tile.
# TIDE_CELL and tide.assign_cells are written for 0.02° tide cells.
assert TIDE["cells_per_degree"] == 50
TIDE_CELL = """(((p.tile_id // 360) * 50
    + greatest(least(floor((p.lat - (p.tile_id // 360 - 90)) * 50), 49), 0))::BIGINT * 18000
  + (p.tile_id % 360) * 50
  + greatest(least(floor((p.lon - (p.tile_id % 360 - 180)) * 50), 49), 0))"""
# Metres of tide uncertainty per km between a sounding and its station: a starting
# value, until held-out gauges measure it.
TIDE_KM_SIGMA = TIDE["sigma_per_km"]
# The uncertainty a correction that isn't made leaves in a depth, so uncorrected water
# never reads as better known than corrected: tide left in (half a range of a metre or
# two), and a vessel's offset left in (vessels read 0 to 3 m shallow in the Chesapeake).
# Starting values.
UNTIDED_SIGMA = STATISTIC["untided_sigma_m"]
UNCALIBRATED_SIGMA = STATISTIC["uncalibrated_sigma_m"]

# A point's base row (1/3″ of latitude) within its 1° tile. The cells build bands and
# rows by this one expression, so a point can't land between two bands.
_ROWS = CELLS["rows_per_degree"]
BASE_ROW = f"least(floor((p.lat - (p.tile_id // 360 - 90)) * {_ROWS})::INTEGER, {_ROWS - 1})"

# A sounding is its file and row, packed into one key: both stay under 2^31. A copy
# taking a file's points over moves them, and their flags, to its file_id.
POINT_ID = '(p.file_id::BIGINT << 32) | p."row"'

# A sounding by its content alone, the same whichever file holds it: what samples and
# ties are picked by, so a copy taking a file's points over changes neither.
CONTENT_KEY = 'hash(f.content_hash, p."row")'

# Partitioned by the 10° cell, so the cells build reads only its partition's rows.
PARTITIONED = {"points": "cell_id", "cells": "cell_id", "qc_flags": "cell_id", "shoals": "cell_id"}

# Points of active files, with the cross-source and same-vessel duplicates of
# dedupe rules 4 and 5 removed. Rule 5: a noaa sounding inside the time span of
# an active openwaters file from the same vessel is NOAA's simplified copy of it.
# NOAA keeps the plugin's milliseconds; the span is widened to whole seconds as a
# margin in case a copy is written with fewer.
# Rule 4: identical soundings in overlapping files count once; every row of the
# lowest file_id is kept, so loggers faster than 1 Hz keep their repeated times.
# Only a sounding in a time two active files of its vessel both cover can have a twin,
# so only those go through the dedupe window, whose memory grows with its input. The
# shared times come from a sweep over the files' start and end times, so their cost
# follows the number of files, not soundings: a boat logging for years at its mooring
# shares only the minutes where its uploads overlap.
# ponytail: the sweep runs for every query; keep it in a table if the files grow slow
ACTIVE = f"""
WITH f AS (
  SELECT file_id, source, vessel, time_min, time_max, content_hash FROM lake.files
  WHERE status = 'active'
),
ow AS (SELECT vessel, time_min, time_max FROM f WHERE source = 'openwaters'),
ends AS (
  -- A file with no plausible times has no span; QC rejects all its soundings.
  SELECT source, vessel, time_min AS t, 1 AS d FROM f WHERE time_min IS NOT NULL
  UNION ALL SELECT source, vessel, time_max, -1 FROM f WHERE time_max IS NOT NULL
),
sweep AS (
  -- Starts sort before ends at the same time, so files that touch count as sharing it.
  SELECT source, vessel, t, sum(d) OVER (PARTITION BY source, vessel ORDER BY t, d DESC
      ROWS UNBOUNDED PRECEDING) AS open,
    lead(t) OVER (PARTITION BY source, vessel ORDER BY t, d DESC) AS t_next
  FROM ends
),
shared AS (SELECT source, vessel, t AS t0, t_next AS t1 FROM sweep WHERE open >= 2),
p AS (
  SELECT p.*, {POINT_ID} AS point_id, {CONTENT_KEY} AS content_key, f.source, EXISTS (
      SELECT 1 FROM shared s WHERE s.source = f.source AND s.vessel = f.vessel
        AND p.time BETWEEN s.t0 AND s.t1) AS twinned
  FROM lake.points p JOIN f USING (file_id)
  WHERE {{where}} AND NOT (f.source = 'noaa' AND EXISTS (
    SELECT 1 FROM ow WHERE ow.vessel = p.unique_id AND p.time >= date_trunc('second', ow.time_min)
    AND p.time < date_trunc('second', ow.time_max) + INTERVAL 1 SECOND))
)
SELECT * EXCLUDE (twinned) FROM p WHERE NOT twinned
UNION ALL BY NAME
SELECT * EXCLUDE (twinned, r) FROM (
  SELECT *, dense_rank() OVER (
    PARTITION BY source, unique_id, time, lon, lat, depth_raw ORDER BY file_id) AS r
  FROM p WHERE twinned
) WHERE r = 1
"""
ACTIVE_POINTS = f"""
CREATE OR REPLACE TEMP VIEW active_points AS {ACTIVE.format(where="true")};
-- The same for one unit of cell work: a 10° partition, optionally some of its tiles
-- and a band of base rows, filtered before the dedupe so the work is the unit's alone.
-- `vessels`, optionally, keeps only theirs: every step of the dedupe is within a vessel,
-- so leaving the others out first changes nothing but the cost.
CREATE OR REPLACE TEMP MACRO active_points_in(cell, tiles, rlo, rhi, vessels := []::VARCHAR[]) AS TABLE {
    ACTIVE.format(
        where="p.cell_id = cell AND (len(tiles) = 0 OR list_contains(tiles, p.tile_id))"
        f" AND {BASE_ROW} BETWEEN rlo AND rhi - 1"
        " AND (len(vessels) = 0 OR list_contains(vessels, p.unique_id))"
    )
};
-- Those points with their corrections: `tide`, the level above chart datum at the
-- sounding's time, interpolated in its half hour; `offset_m`, its calibrated segment's
-- offset; `depth`, depth_raw reduced by both; and `sigma`, both corrections'
-- uncertainty, the tide's widened by the station's distance. A correction that doesn't
-- apply is NULL and leaves the depth as it is, and its uncertainty as UNTIDED_SIGMA or
-- UNCALIBRATED_SIGMA. `excluded` marks a vessel segment known to read too deep to use, and
-- `lost_bottom` a sounding calibration found its sounder had lost the bottom for: a stray
-- transit that read far too shallow, a stuck run, or a month a vessel mostly read so.
CREATE OR REPLACE TEMP MACRO corrected_points_in(cell, tiles, rlo, rhi, vessels := []::VARCHAR[]) AS TABLE
WITH c AS (
  SELECT tide_cell, station_id, km FROM lake.tide_cells
  WHERE len(tiles) = 0 OR list_contains(tiles, tile_id)
),
-- Only the stations of these tiles' cells, so the join holds their levels alone.
l AS (SELECT * FROM lake.tide_levels WHERE station_id IN (SELECT station_id FROM c)),
p AS (
  SELECT p.*, c.tide_cell IS NOT NULL AS tide_assigned, c.station_id AS tide_station,
    coalesce(o.excluded, false) AS excluded,
    coalesce(o.lost_bottom, false) OR EXISTS (
      SELECT 1 FROM lake.lost_runs r JOIN lake.files f USING (content_hash)
      WHERE f.file_id = p.file_id AND r.vessel = p.unique_id
        AND (r.tile_id IS NULL OR r.tile_id = p.tile_id)
        AND p.time BETWEEN r.t_start AND r.t_end
    ) AS lost_bottom,
    l.level + l.slope * epoch(p.time - l.slot) AS tide,
    sqrt(l.sigma ^ 2 + (c.km * {TIDE_KM_SIGMA}) ^ 2) AS tide_sigma, o.offset_m, o.se_m
  FROM active_points_in(cell, tiles, rlo, rhi, vessels := vessels) p
  LEFT JOIN c ON c.tide_cell = {TIDE_CELL}
  LEFT JOIN l ON l.station_id = c.station_id AND l.slot = time_bucket(INTERVAL 30 MINUTE, p.time)
  LEFT JOIN lake.file_offsets o ON o.file_id = p.file_id AND o.vessel = p.unique_id
)
SELECT * EXCLUDE (tide_sigma, se_m),
  -- A station is in reach but its level for this day isn't made yet: the raw depth would
  -- read deeper than chart datum whenever the tide is above it.
  tide IS NULL AND tide_station IS NOT NULL AS awaiting_tide,
  (depth_raw - coalesce(tide, 0) - coalesce(offset_m, 0))::FLOAT AS depth,
  sqrt(coalesce(tide_sigma, {UNTIDED_SIGMA}) ^ 2 + coalesce(se_m, {UNCALIBRATED_SIGMA}) ^ 2)
    AS sigma
FROM p;
"""


class Locked(Exception):
    pass


class Lock:
    """A lock object written with a conditional put and renewed while the run works.

    A lock whose expiry has passed has stopped being renewed and can be taken over.
    """

    def __init__(self, objects, ttl=timedelta(minutes=10)):
        self.objects = objects
        self.ttl = ttl
        self.owner = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self.etag = None
        self.lost = threading.Event()
        # When the last write of the lock that's known to have landed was sent: its
        # expiry is at least a TTL after this.
        self.renewed = None
        self._stop = threading.Event()

    def _body(self) -> bytes:
        expires = datetime.now(UTC) + self.ttl
        return json.dumps({"owner": self.owner, "expires": expires.isoformat()}).encode()

    def acquire(self):
        sent = datetime.now(UTC)
        try:
            self.etag = self.objects.put(LOCK, self._body(), if_none_match=True)
        except Conflict:
            current = self.objects.get(LOCK)
            if current is None:
                return self.acquire()
            held = json.loads(current[0])
            if held["owner"] == self.owner:
                # This run's put landed, but its response was lost and the retry failed.
                self.etag = current[1]
                return self._start(sent)
            if datetime.fromisoformat(held["expires"]) > datetime.now(UTC):
                raise Locked(f"catalog locked by {held['owner']} until {held['expires']}")
            if not held.get("released"):
                log.warning("taking over stale lock from %s", held["owner"])
            try:
                self.etag = self.objects.put(LOCK, self._body(), if_match=current[1])
            except Conflict:
                now = self.objects.get(LOCK)
                if not now or json.loads(now[0])["owner"] != self.owner:
                    raise Locked("another run took the stale lock first")
                self.etag = now[1]
        self._start(sent)

    def _start(self, sent):
        self.renewed = sent
        self._thread = threading.Thread(target=self._renew, daemon=True)
        self._thread.start()

    def _renew(self):
        while not self._stop.wait(self.ttl.total_seconds() / 4):
            sent = datetime.now(UTC)
            try:
                self.etag = self.objects.put(LOCK, self._body(), if_match=self.etag)
                self.renewed = sent
                continue
            except Exception:
                log.warning("renewing the catalog lock failed", exc_info=True)
            # A renewal that succeeded but whose response was lost fails its retry
            # with a 412; the lock is still ours if it still names this run and hasn't
            # expired, since another run may take over an expired lock at any moment.
            current = self._held()
            held = current and json.loads(current[0])
            if (
                held
                and held["owner"] == self.owner
                and datetime.fromisoformat(held["expires"]) > datetime.now(UTC)
            ):
                self.etag = current[1]
            elif current or datetime.now(UTC) - self.renewed >= self.ttl:
                # Another run holds it, or it may have expired while unreachable.
                log.error("lost the catalog lock")
                self.lost.set()
                return

    def check(self):
        """Raise Locked unless the lease has at least half its TTL left.

        Another run can take the lock over only once a full TTL has passed without a
        renewal, so a publish that starts with half of it left finishes while the lock
        is still this run's, even if renewal has stalled.
        """
        if self.lost.is_set() or datetime.now(UTC) - self.renewed >= self.ttl / 2:
            raise Locked("the catalog lock was lost or its lease ran low; result discarded")

    def _held(self):
        try:
            return self.objects.get(LOCK)
        except (BotoCoreError, ClientError, OSError):
            return None

    def release(self):
        self._stop.set()
        self._thread.join()
        if self.lost.is_set():
            return
        # Releasing marks the lock expired with a write conditional on this run's
        # version, so it can't clobber a lock another run has taken over since.
        # The next run takes the expired lock over like any stale one.
        body = json.dumps(
            {"owner": self.owner, "expires": datetime.now(UTC).isoformat(), "released": True}
        )
        try:
            self.objects.put(LOCK, body.encode(), if_match=self.etag)
        except Conflict:
            log.warning("the catalog lock changed hands before release")
        except (BotoCoreError, ClientError, OSError):
            # Never mask the error that ended the run; the lock expires on its own.
            log.warning("releasing the catalog lock failed", exc_info=True)


def connect(
    catalog_path: str, data_url: str, temp_dir: str, write=True
) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # A fixed budget per process, so several can run side by side; work past it
    # spills to disk instead of growing.
    con.execute("SET memory_limit = ?", [os.environ.get("GRID_MEMORY_LIMIT") or MEMORY_LIMIT])
    con.execute("SET temp_directory = ?", [temp_dir])
    # A partitioned write buffers rows for every partition it has open: cap both, so a
    # track crossing many 10° cells costs a fixed amount.
    con.execute("SET partitioned_write_flush_threshold = 100000")
    con.execute("SET partitioned_write_max_open_files = 16")
    # Times are read and stored in UTC whatever the host's zone.
    con.execute("SET TimeZone = 'UTC'")
    con.execute("INSTALL ducklake; LOAD ducklake")
    if data_url.startswith("s3://"):
        con.execute("INSTALL httpfs; LOAD httpfs")
        for setting in HTTP_RETRIES:
            con.execute(setting)
        con.execute(
            "CREATE SECRET (TYPE s3, KEY_ID ?, SECRET ?, ENDPOINT ?, REGION ?, URL_STYLE 'path')",
            [
                os.environ["S3_ACCESS_KEY_ID"],
                os.environ["S3_SECRET_ACCESS_KEY"],
                os.environ["S3_ENDPOINT"].removeprefix("https://"),
                os.environ.get("S3_REGION", "auto"),
            ],
        )
    attach(con, catalog_path, data_url)
    existing = {
        name
        for (name,) in con.execute(
            "SELECT table_name FROM duckdb_tables() WHERE database_name = 'lake'"
        ).fetchall()
    }
    con.execute(SCHEMA)
    con.execute(MIGRATIONS)
    # Partitioning is set once, when a table is created.
    for table in PARTITIONED.keys() - existing:
        con.execute(f"ALTER TABLE lake.{table} SET PARTITIONED BY ({PARTITIONED[table]})")
    check_hash_scheme(con)
    migrate_layout(con, write)
    con.execute(ACTIVE_POINTS)
    return con


def attach(con, catalog_path: str, data_url: str):
    # Inlining keeps the small per-file writes to files and submission_meta in the
    # catalog instead of a Parquet file each. A local store's data is its own folder
    # wherever that is, so a copied or cloned store reads its own files rather than
    # refusing the path the catalog was built at; data files are stored relative to it.
    local = "" if data_url.startswith("s3://") else ", OVERRIDE_DATA_PATH true"
    con.execute(
        f"ATTACH {literal('ducklake:' + catalog_path)} AS lake"
        f" (DATA_PATH {literal(data_url)}, DATA_INLINING_ROW_LIMIT 1000{local})"
    )


# Content hashes must all come from one scheme, or rule 1 misses copies and points are
# stored twice. Change this with any change to how sources.content_hash derives them. A
# store records it with its layout (LAYOUT), so a build that keys points another way
# refuses the store too: builds before LAYOUT check for the scheme alone.
HASH_SCHEME = "md5-sum-2"


def check_hash_scheme(con):
    scheme = con.execute("SELECT value FROM lake.store_meta WHERE key = 'hash'").fetchone()
    if scheme is None:
        if con.execute("SELECT count(*) FROM lake.files").fetchone()[0]:
            raise RuntimeError("store predates hash scheme records; rebuild it")
        con.execute("INSERT INTO lake.store_meta VALUES ('hash', ?)", [STORE_SCHEME])
    elif scheme[0] != STORE_SCHEME:
        # The scheme alone is a store from before LAYOUT, which migrate_layout brings over;
        # anything else is refused before the migration touches it.
        layout = con.execute("SELECT value FROM lake.store_meta WHERE key = 'layout'").fetchone()
        if scheme[0] != HASH_SCHEME or layout:
            raise RuntimeError(f"store hashes with {scheme[0]}, this build with {STORE_SCHEME}")


# Points and flags sorted by tile within each 10° partition, so a tile reads a few row
# groups of its own rather than the partition's ingest order, which reads the store 6.8
# times over in a full rebuild (store-layout.md). Every insert is written sorted, and
# `compact` rewrites a partition into sorted files of about TARGET_FILE_SIZE.
LAYOUT = "sorted-1"
STORE_SCHEME = f"{HASH_SCHEME}/{LAYOUT}"
SORTED = {"points": "tile_id, lat, lon", "qc_flags": "tile_id, point_id"}
TARGET_FILE_SIZE = "256MB"
ROW_GROUP_ROWS = 122_880


def migrate_layout(con, write=True):
    """Bring a store to LAYOUT in the catalog alone: drop the stored point_id, which
    POINT_ID replaces, rekey qc_flags, whose flags QC and the next cells build write again,
    and set each table's sort. `compact` rewrites the points themselves. A read-only open
    refuses a store from before LAYOUT, whose flags exist only once QC runs again."""
    done = con.execute("SELECT value FROM lake.store_meta WHERE key = 'layout'").fetchone()
    if done and done[0] == LAYOUT:
        return
    if done:
        raise RuntimeError(f"store is at layout {done[0]}, this build at {LAYOUT}")
    if not write and con.execute("SELECT count(*) FROM lake.files").fetchone()[0]:
        raise RuntimeError(f"store predates layout {LAYOUT}; run `grid compact` first")

    def columns(table):
        return {
            c
            for (c,) in con.execute(
                "SELECT column_name FROM duckdb_columns() WHERE database_name = 'lake'"
                " AND table_name = ?",
                [table],
            ).fetchall()
        }

    con.execute("BEGIN")
    try:
        if "point_id" in columns("points"):
            con.execute("ALTER TABLE lake.points DROP COLUMN point_id")
        if "tile_id" not in columns("qc_flags"):
            con.execute("DROP TABLE lake.qc_flags")
            con.execute(SCHEMA)
            con.execute("ALTER TABLE lake.qc_flags SET PARTITIONED BY (cell_id)")
            con.execute("DELETE FROM lake.qc_batches")
        for table, order in SORTED.items():
            con.execute(f"ALTER TABLE lake.{table} SET SORTED BY ({order})")
        con.execute("CALL ducklake_set_option('lake', 'target_file_size', ?)", [TARGET_FILE_SIZE])
        con.execute(
            "CALL ducklake_set_option('lake', 'parquet_row_group_size', ?)", [str(ROW_GROUP_ROWS)]
        )
        con.execute("DELETE FROM lake.store_meta WHERE key = 'layout'")
        con.execute("INSERT INTO lake.store_meta VALUES ('layout', ?)", [LAYOUT])
        # So builds that key points by a stored point_id refuse the store.
        con.execute(
            "UPDATE lake.store_meta SET value = $new WHERE key = 'hash'"
            " AND (value = $scheme OR starts_with(value, $scheme || '/'))",
            {"new": STORE_SCHEME, "scheme": HASH_SCHEME},
        )
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise


def compact(con, publish=None) -> int:
    """Rewrite each partition's points not yet compacted at LAYOUT into sorted files, one
    partition per transaction, so a stopped run resumes at the next. Returns how many it
    rewrote. The old files stay until snapshots expire, RETAIN after the run."""
    done = {
        v
        for (v,) in con.execute(
            "SELECT value FROM lake.store_meta WHERE key = 'compacted'"
        ).fetchall()
    }
    cells = [
        c
        for (c,) in con.execute("SELECT DISTINCT cell_id FROM lake.points ORDER BY 1").fetchall()
        if f"{LAYOUT}:{c}" not in done
    ]
    for cell in cells:
        # The rows written now get higher row ids, which tell them from the old ones.
        [(last,)] = con.execute("SELECT max(rowid) FROM lake.points").fetchall()
        con.execute("BEGIN")
        try:
            con.execute(
                "INSERT INTO lake.points SELECT * FROM lake.points WHERE cell_id = ?", [cell]
            )
            con.execute("DELETE FROM lake.points WHERE cell_id = ? AND rowid <= ?", [cell, last])
            con.execute("INSERT INTO lake.store_meta VALUES ('compacted', ?)", [f"{LAYOUT}:{cell}"])
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
        log.info("compacted partition %s", cell)
        if publish:
            publish()
    return len(cells)


class Session:
    """The connection open_store yields, which can also publish the catalog partway through a run."""

    def __init__(self, con, publish, write=True):
        self.con = con
        self._publish = publish
        # When it last published; None for a read-only session, which never does.
        self.published = time.monotonic() if write else None

    def publish(self):
        key = self._publish()
        self.published = time.monotonic()
        return key

    def __getattr__(self, name):
        return getattr(self.con, name)


def checkpoint(con):
    """Publish a session's catalog if CHECKPOINT_SECONDS have passed since it last did.

    Call it only between units of work, with no transaction open. A plain connection
    or a read-only session, with no catalog to publish, is left alone.
    """
    published = getattr(con, "published", None)
    if published is not None and time.monotonic() - published >= CHECKPOINT_SECONDS:
        con.publish()


def flush_inlined(con):
    """Move the rows inlined so far to Parquet, so the catalog each run downloads stays small."""
    # DuckLake (ac7595b0, the build DuckDB 1.5.6 installs) finishes each table's flush on
    # its own thread and records it in a list with no lock, which now and then corrupts
    # memory and crashes the process. On one thread the tables finish in turn. DuckLake
    # main locks the list; drop this once the installed build has that lock.
    threads = con.execute("SELECT current_setting('threads')").fetchone()[0]
    con.execute("SET threads = 1")
    try:
        con.execute("CALL ducklake_flush_inlined_data('lake')")
    finally:
        con.execute(f"SET threads = {threads}")


@contextmanager
def open_store(store, write=True, ttl=timedelta(minutes=10)):
    """Yield a connection to the catalog the pointer names, and publish its result on success.

    The result is uploaded under a new key, and the pointer moves with a conditional
    write against the version this run last published or started from, so a run that
    lost its lock can't overwrite a newer catalog and a crashed run leaves the last good
    one. A long run can publish partway with `publish()`, between transactions, so a
    failure later keeps what it had done. A read-only open takes no lock and publishes
    nothing.
    """
    lock = Lock(store, ttl)
    if write:
        lock.acquire()
    try:
        # Spill files go in a directory of this process's own: DuckDB names them the
        # same in every process, so two runs sharing one directory crash each other.
        with (
            tempfile.TemporaryDirectory() as tmp,
            tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None) as spill,
        ):
            local = Path(tmp) / "catalog.ducklake"
            pointer = store.get(POINTER)
            if pointer:
                local.write_bytes(store.get(pointer[0].decode())[0])
            base = pointer and pointer[1]
            data_url = store.url + "lake/"
            if isinstance(store, LocalObjects):
                Path(data_url).mkdir(parents=True, exist_ok=True)
            con = connect(str(local), data_url, spill, write)
            cutoff = datetime.now(UTC) - RETAIN

            def publish(final=False):
                nonlocal base, cutoff
                if not write:
                    raise RuntimeError("a read-only store publishes nothing")
                flush_inlined(con)
                if final:
                    # Rebuilds delete and reinsert cells, their flags and shoals, the
                    # calibration and the cells' marker, and DuckLake deletes by writing
                    # delete files, so the replaced files stay live until rewritten.
                    # Small files, a run's inserts, merge into sorted ones.
                    for table in SORTED:
                        con.execute(f"CALL ducklake_merge_adjacent_files('lake', '{table}')")
                    for table in (
                        "points",
                        "file_tiles",
                        "cells",
                        "qc_flags",
                        "shoals",
                        "store_meta",
                        "cells_built",
                        "calibration",
                        "calibration_outliers",
                        "lost_runs",
                        "file_offsets",
                        "tile_changes",
                        "tide_cells",
                        "tide_stations",
                        "tide_levels",
                        "tide_residuals",
                        "tide_residual_months",
                    ):
                        con.execute(f"CALL ducklake_rewrite_data_files('lake', '{table}')")
                    # A reader may still hold a catalog up to RETAIN old, so snapshots, the
                    # files only they reference, and old catalogs go once they pass it.
                    # Taken after the rewrite, so this run's rewrite doesn't count toward it.
                    cutoff = datetime.now(UTC) - RETAIN
                    older = {"cutoff": cutoff.replace(tzinfo=None)}  # session time zone is UTC
                    con.execute(
                        "CALL ducklake_expire_snapshots('lake', older_than => $cutoff)", older
                    )
                    con.execute(
                        "CALL ducklake_cleanup_old_files('lake', older_than => $cutoff)", older
                    )
                con.execute("DETACH lake")
                lock.check()
                stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
                key = f"catalog/{stamp}-{uuid.uuid4().hex[:8]}.ducklake"
                try:
                    store.put(key, local.read_bytes(), if_none_match=True)
                except Conflict:
                    # The key is this run's own, so a 412 means an earlier try landed.
                    if store.get(key) is None:
                        raise
                lock.check()  # the upload can take a while
                try:
                    if base:
                        base = store.put(POINTER, key.encode(), if_match=base)
                    else:
                        base = store.put(POINTER, key.encode(), if_none_match=True)
                except Conflict:
                    # A put whose response was lost fails its retry with a 412; it
                    # landed if the pointer names this catalog.
                    current = store.get(POINTER)
                    if not current or current[0].decode() != key:
                        raise
                    base = current[1]
                log.info("catalog now %s", key)
                if not final:
                    attach(con, str(local), data_url)
                return key

            yield Session(con, publish, write)
            if not write:
                con.close()
                return
            key = publish(final=True)
            con.close()
            # The catalog this run started from stays a run longer: a reader may have
            # read the pointer just before it moved.
            keep = {key, pointer and pointer[0].decode()}
            for obj in store.list("catalog/")[0]:
                if obj.key.endswith(".ducklake") and obj.key not in keep and obj.modified < cutoff:
                    store.delete(obj.key)
    finally:
        if write:
            lock.release()
