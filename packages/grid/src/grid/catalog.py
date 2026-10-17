"""The DuckLake catalog: one writer at a time, a renewed lock, and a conditionally moved pointer."""

import json
import logging
import os
import socket
import tempfile
import threading
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import duckdb
from botocore.exceptions import BotoCoreError, ClientError

from .objects import Conflict, LocalObjects
from .sources import literal

log = logging.getLogger(__name__)

LOCK = "catalog/lock"
MEMORY_LIMIT = "4GB"
RETAIN = timedelta(days=7)
POINTER = "catalog/current"

SCHEMA = """
CREATE TABLE IF NOT EXISTS lake.files (
  file_id BIGINT, source VARCHAR, key VARCHAR, version INTEGER, file_uuid VARCHAR, vessel VARCHAR,
  etag VARCHAR, content_hash VARCHAR, arrival TIMESTAMP, ingested TIMESTAMP,
  time_min TIMESTAMP, time_max TIMESTAMP, point_count BIGINT, has_points BOOLEAN,
  status VARCHAR, reason VARCHAR, superseded_by BIGINT
);
CREATE TABLE IF NOT EXISTS lake.points (
  point_id BLOB, file_id BIGINT, "row" INTEGER, unique_id VARCHAR, platform VARCHAR, provider VARCHAR,
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
CREATE TABLE IF NOT EXISTS lake.store_meta (key VARCHAR, value VARCHAR);
CREATE TABLE IF NOT EXISTS lake.qc_flags (
  point_id BLOB, flag VARCHAR, reason VARCHAR, qc_version INTEGER, cell_id SMALLINT
);
CREATE TABLE IF NOT EXISTS lake.cells (
  tile_id INTEGER, level TINYINT, "row" INTEGER, col INTEGER,
  lon_min DOUBLE, lat_min DOUBLE, lon_max DOUBLE, lat_max DOUBLE,
  depth FLOAT, median FLOAT, mad FLOAT, min FLOAT, max FLOAT, count INTEGER, vessels INTEGER,
  first DATE, last DATE, tvu FLOAT, kind VARCHAR, zoc TINYINT,
  depth_lon DOUBLE, depth_lat DOUBLE, cell_id SMALLINT, grid_version INTEGER
);
"""

# A point's base row (1/3″ of latitude) within its 1° tile. The cells build bands and
# rows by this one expression, so a point can't land between two bands.
BASE_ROW = "least(floor((p.lat - (p.tile_id // 360 - 90)) * 10800)::INTEGER, 10799)"

# Partitioned by the 10° cell, so the cells build reads only its partition's rows.
PARTITIONED = {"points": "cell_id", "cells": "cell_id", "qc_flags": "cell_id"}

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
ACTIVE = """
WITH f AS (
  SELECT file_id, source, vessel, time_min, time_max FROM lake.files WHERE status = 'active'
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
  SELECT p.*, f.source, EXISTS (
      SELECT 1 FROM shared s WHERE s.source = f.source AND s.vessel = f.vessel
        AND p.time BETWEEN s.t0 AND s.t1) AS twinned
  FROM lake.points p JOIN f USING (file_id)
  WHERE {where} AND NOT (f.source = 'noaa' AND EXISTS (
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
CREATE OR REPLACE TEMP MACRO active_points_in(cell, tiles, rlo, rhi) AS TABLE {
    ACTIVE.format(
        where="p.cell_id = cell AND (len(tiles) = 0 OR list_contains(tiles, p.tile_id))"
        f" AND {BASE_ROW} BETWEEN rlo AND rhi - 1"
    )
};
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
            # with a 412; the lock is still ours if it still names this run.
            current = self._held()
            if current and json.loads(current[0])["owner"] == self.owner:
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


def connect(catalog_path: str, data_url: str, temp_dir: str) -> duckdb.DuckDBPyConnection:
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
    check_hash_scheme(con)
    # Partitioning is set once, when a table is created.
    for table in PARTITIONED.keys() - existing:
        con.execute(f"ALTER TABLE lake.{table} SET PARTITIONED BY ({PARTITIONED[table]})")
    con.execute(ACTIVE_POINTS)
    return con


def attach(con, catalog_path: str, data_url: str):
    # Inlining keeps the small per-file writes to files and submission_meta in the
    # catalog instead of a Parquet file each.
    con.execute(
        f"ATTACH {literal('ducklake:' + catalog_path)} AS lake"
        f" (DATA_PATH {literal(data_url)}, DATA_INLINING_ROW_LIMIT 1000)"
    )


# Content hashes and the point ids derived from them must all come from one scheme, or
# rule 1 misses copies and points are stored twice. Change this with any change to how
# sources.content_hash or ingest.ADD_POINTS derives them.
HASH_SCHEME = "md5-sum-2"


def check_hash_scheme(con):
    scheme = con.execute("SELECT value FROM lake.store_meta WHERE key = 'hash'").fetchone()
    if scheme is None:
        if con.execute("SELECT count(*) FROM lake.files").fetchone()[0]:
            raise RuntimeError("store predates hash scheme records; rebuild it")
        con.execute("INSERT INTO lake.store_meta VALUES ('hash', ?)", [HASH_SCHEME])
    elif scheme[0] != HASH_SCHEME:
        raise RuntimeError(f"store hashes with {scheme[0]}, this build with {HASH_SCHEME}")


class Session:
    """The connection open_store yields, which can also publish the catalog partway through a run."""

    def __init__(self, con, publish):
        self.con = con
        self.publish = publish

    def __getattr__(self, name):
        return getattr(self.con, name)


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
            con = connect(str(local), data_url, spill)
            cutoff = datetime.now(UTC) - RETAIN

            def publish(final=False):
                nonlocal base, cutoff
                if not write:
                    raise RuntimeError("a read-only store publishes nothing")
                # Moves rows inlined so far to Parquet, so the catalog each run downloads stays small.
                con.execute("CALL ducklake_flush_inlined_data('lake')")
                if final:
                    # Rebuilds delete and reinsert cells and their flags, and DuckLake
                    # deletes by writing delete files, so the replaced files stay live
                    # until rewritten.
                    # ponytail: points' delete files wait for compaction, which is still to come
                    for table in ("cells", "qc_flags"):
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

            yield Session(con, publish)
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
