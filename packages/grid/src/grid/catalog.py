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

log = logging.getLogger(__name__)

LOCK = "catalog/lock"
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
"""

# Points of active files, with the cross-source and same-vessel duplicates of
# dedupe rules 4 and 5 removed. Rule 5: a noaa sounding inside the time span of
# an active openwaters file from the same vessel is NOAA's simplified copy of it.
# NOAA keeps the plugin's milliseconds; the span is widened to whole seconds as a
# margin in case a copy is written with fewer.
# Rule 4: identical soundings in overlapping files count once; every row of the
# lowest file_id is kept, so loggers faster than 1 Hz keep their repeated times.
ACTIVE_POINTS = """
CREATE OR REPLACE TEMP VIEW active_points AS
WITH f AS (SELECT file_id, source FROM lake.files WHERE status = 'active'),
ow AS (SELECT vessel, time_min, time_max FROM lake.files WHERE status = 'active' AND source = 'openwaters'),
p AS (
  SELECT p.*, f.source FROM lake.points p JOIN f USING (file_id)
  WHERE NOT (f.source = 'noaa' AND EXISTS (
    SELECT 1 FROM ow WHERE ow.vessel = p.unique_id AND p.time >= date_trunc('second', ow.time_min)
    AND p.time < date_trunc('second', ow.time_max) + INTERVAL 1 SECOND))
)
SELECT * EXCLUDE (r) FROM (
  SELECT *, dense_rank() OVER (
    PARTITION BY source, unique_id, time, lon, lat, depth_raw ORDER BY file_id) AS r
  FROM p
) WHERE r = 1
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
        self._stop = threading.Event()

    def _body(self) -> bytes:
        expires = datetime.now(UTC) + self.ttl
        return json.dumps({"owner": self.owner, "expires": expires.isoformat()}).encode()

    def acquire(self):
        try:
            self.etag = self.objects.put(LOCK, self._body(), if_none_match=True)
        except Conflict:
            current = self.objects.get(LOCK)
            if current is None:
                return self.acquire()
            held = json.loads(current[0])
            if datetime.fromisoformat(held["expires"]) > datetime.now(UTC):
                raise Locked(f"catalog locked by {held['owner']} until {held['expires']}")
            log.warning("taking over stale lock from %s", held["owner"])
            try:
                self.etag = self.objects.put(LOCK, self._body(), if_match=current[1])
            except Conflict:
                raise Locked("another run took the stale lock first")
        self._thread = threading.Thread(target=self._renew, daemon=True)
        self._thread.start()

    def _renew(self):
        renewed = datetime.now(UTC)
        while not self._stop.wait(self.ttl.total_seconds() / 4):
            try:
                self.etag = self.objects.put(LOCK, self._body(), if_match=self.etag)
                renewed = datetime.now(UTC)
                continue
            except Exception:
                log.warning("renewing the catalog lock failed", exc_info=True)
            # A renewal that succeeded but whose response was lost fails its retry
            # with a 412; the lock is still ours if it still names this run.
            current = self._held()
            if current and json.loads(current[0])["owner"] == self.owner:
                self.etag = current[1]
            elif current or datetime.now(UTC) - renewed >= self.ttl:
                # Another run holds it, or it may have expired while unreachable.
                log.error("lost the catalog lock")
                self.lost.set()
                return

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
        body = json.dumps({"owner": self.owner, "expires": datetime.now(UTC).isoformat()})
        try:
            self.objects.put(LOCK, body.encode(), if_match=self.etag)
        except Conflict:
            log.warning("the catalog lock changed hands before release")
        except (BotoCoreError, ClientError, OSError):
            # Never mask the error that ended the run; the lock expires on its own.
            log.warning("releasing the catalog lock failed", exc_info=True)


def connect(catalog_path: str, data_url: str) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
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
    # Inlining keeps the small per-file writes to files and submission_meta in the
    # catalog instead of a Parquet file each.
    con.execute(
        f"ATTACH 'ducklake:{catalog_path}' AS lake (DATA_PATH '{data_url}', DATA_INLINING_ROW_LIMIT 1000)"
    )
    new = not con.execute(
        "SELECT 1 FROM duckdb_tables() WHERE database_name = 'lake' AND table_name = 'points'"
    ).fetchone()
    con.execute(SCHEMA)
    if new:
        con.execute("ALTER TABLE lake.points SET PARTITIONED BY (cell_id)")
    con.execute(ACTIVE_POINTS)
    return con


@contextmanager
def open_store(store, write=True, ttl=timedelta(minutes=10)):
    """Yield a connection to the catalog the pointer names, and publish its result on success.

    The result is uploaded under a new key, and the pointer moves with a conditional
    write against the version this run started from, so a run that lost its lock
    can't overwrite a newer catalog and a crashed run leaves the last good one.
    A read-only open takes no lock and publishes nothing.
    """
    lock = Lock(store, ttl)
    if write:
        lock.acquire()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "catalog.ducklake"
            pointer = store.get(POINTER)
            if pointer:
                local.write_bytes(store.get(pointer[0].decode())[0])
            data_url = store.url + "lake/"
            if isinstance(store, LocalObjects):
                Path(data_url).mkdir(parents=True, exist_ok=True)
            con = connect(str(local), data_url)
            yield con
            if not write:
                con.close()
                return
            # Moves rows inlined during the run to Parquet, so the catalog each run downloads stays small.
            con.execute("CALL ducklake_flush_inlined_data('lake')")
            con.execute("DETACH lake")
            con.close()
            if lock.lost.is_set():
                raise Locked("lost the catalog lock; result discarded")
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
            key = f"catalog/{stamp}-{uuid.uuid4().hex[:8]}.ducklake"
            store.put(key, local.read_bytes(), if_none_match=True)
            # ponytail: old catalog versions accumulate; prune them once snapshots expire
            if pointer:
                store.put(POINTER, key.encode(), if_match=pointer[1])
            else:
                store.put(POINTER, key.encode(), if_none_match=True)
            log.info("catalog now %s", key)
    finally:
        if write:
            lock.release()
