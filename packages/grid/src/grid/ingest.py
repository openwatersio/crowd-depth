"""Ingest one source's listing into the point store, deduplicating by file.

Statuses and reasons in `files`:

- active: its points are used.
- superseded/copy: same content as another file (rule 1); holds no points.
- superseded/replaced: an older version of the same key (rule 2).
- superseded/covered: a newer file from the same vessel holds all its soundings (rule 4).
- withdrawn: gone from its source (rule 3).
- invalid: can't be parsed or holds impossible values.

The points of one content hash live with exactly one file (`has_points`), so a
point_id, derived from the content hash and row, is never stored twice. When
that file leaves, a copy takes its points over instead of storing them again.
"""

import hashlib
import logging
import math
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime

import pyarrow as pa
from botocore.exceptions import BotoCoreError, ClientError

from .sources import NOAA_PREFIX, Invalid, Parsed, arrival, is_submission, parse

log = logging.getLogger(__name__)

# Share of a source's active files one listing may withdraw before it's held.
WITHDRAWAL_LIMIT = 0.01
FLUSH_POINTS = 2_000_000
FETCHERS = 16
# NOAA's response, newest layout first. `.failed.json` marks a retry the API still owes.
SIDECARS = (".done.json", ".result.json")
OTHER_SIDECARS = (".failed.json",)


@dataclass
class Row:
    file_id: int
    key: str
    version: int
    etag: str
    content_hash: str | None
    status: str
    reason: str | None
    has_points: bool


def tile_id(lon: float, lat: float) -> int:
    """1° tile, row-major from (-180, -90)."""
    return min(math.floor(lat) + 90, 179) * 360 + min(math.floor(lon) + 180, 359)


def cell_id(lon: float, lat: float) -> int:
    """10° partition cell."""
    return min(math.floor(lat / 10) + 9, 17) * 36 + min(math.floor(lon / 10) + 18, 35)


def morton(lon: float, lat: float) -> int:
    """Z-order of the position within its 1° tile, at 16 bits (about 1.7 m) per axis."""
    x = int((lon - math.floor(lon)) * 0xFFFF)
    y = int((lat - math.floor(lat)) * 0xFFFF)
    z = 0
    for i in range(16):
        z |= ((x >> i) & 1) << (2 * i) | ((y >> i) & 1) << (2 * i + 1)
    return z


def point_id(content_hash: str, row: int) -> bytes:
    return hashlib.sha256(bytes.fromhex(content_hash) + row.to_bytes(4, "big")).digest()[:16]


class Ingest:
    def __init__(
        self,
        con,
        source: str,
        objects,
        prefix: str = "",
        now: datetime | None = None,
        max_files: int | None = None,
    ):
        self.con = con
        self.source = source
        self.objects = objects
        # The listing's scope: withdrawals only consider keys under it.
        self.scope = (NOAA_PREFIX if source == "noaa" else "") + prefix
        now = now or datetime.now(UTC)
        self.batch_id = int(now.timestamp() * 1e6)
        self.now = now.astimezone(UTC).replace(tzinfo=None)
        self.buffer: dict[int, list[tuple]] = {}
        self.touched: set[int] = set()
        self.alert = False
        self.counts = Counter()
        # A backfill runs as several bounded runs, each publishing its catalog.
        self.max_files = max_files

    def sql(self, query, params=None):
        return self.con.execute(query, params or [])

    def run(self):
        listing, complete = self.objects.list(self.scope)
        subs = {o.key: o for o in listing if is_submission(self.source, o.key)}
        self.sidecars = {o.key for o in listing if o.key.endswith(SIDECARS)}
        other = sum(o.key.endswith(OTHER_SIDECARS) for o in listing)
        # Hidden files such as .DS_Store are ignored.
        hidden = sum(o.key.rsplit("/", 1)[-1].startswith(".") for o in listing)
        skipped = len(listing) - len(subs) - len(self.sidecars) - other - hidden
        if skipped:
            # A key this code can't read may be a renamed file, so its old key
            # missing from the listing says nothing about a withdrawal.
            complete = False
            # A new key layout would otherwise read as files withdrawn from the source.
            log.warning("%s: %d keys match no known layout", self.source, skipped)
            self.counts["unknown keys"] = skipped
            self.alert = True

        self.sql("BEGIN")
        self.next_id = self.sql("SELECT coalesce(max(file_id), 0) FROM lake.files").fetchone()[0]
        self.holders = {
            h: (fid, status, reason)
            for h, fid, status, reason in self.sql(
                "SELECT content_hash, file_id, status, reason FROM lake.files WHERE has_points"
            ).fetchall()
        }
        self.hash_of = {fid: h for h, (fid, _, _) in self.holders.items()}
        current = {
            r.key: r
            for r in (
                Row(*row)
                for row in self.sql(
                    """SELECT file_id, key, version, etag, content_hash, status, reason, has_points
                    FROM lake.files WHERE source = ? AND starts_with(key, ?)
                    QUALIFY row_number() OVER (PARTITION BY key ORDER BY version DESC) = 1""",
                    [self.source, self.scope],
                ).fetchall()
            )
        }

        work = [
            (subs[key], current.get(key))
            for key in sorted(subs)
            if key not in current or current[key].etag != subs[key].etag
            or current[key].status == "withdrawn"
        ][: self.max_files]  # fmt: skip
        with ThreadPoolExecutor(FETCHERS) as pool:
            # Bounded chunks keep only a few parsed files in memory at once.
            for i in range(0, len(work), FETCHERS * 2):
                chunk = work[i : i + FETCHERS * 2]
                for (obj, row), parsed in zip(chunk, pool.map(self.fetch, [o for o, _ in chunk])):
                    if parsed is None:
                        continue
                    if not isinstance(parsed, Parsed | Invalid):
                        # Unreadable this time: no row, so the next run tries again.
                        self.counts["fetch errors"] += 1
                        self.alert = True
                        continue
                    if row is None:
                        self.ingest(obj, 1, parsed)
                    else:
                        self.changed(row, obj, parsed)
                if sum(map(len, self.buffer.values())) >= FLUSH_POINTS:
                    self.flush()

        self.withdraw(subs, current, complete)
        self.flush()
        self.cover()
        if self.source == "openwaters":
            self.record_responses()
        self.sql("COMMIT")
        log.info("%s: %s", self.source, dict(self.counts))
        return self

    # Files

    def fetch(self, obj) -> Parsed | Invalid | Exception | None:
        try:
            got = self.objects.get(obj.key)
        except (BotoCoreError, ClientError, OSError) as e:
            log.warning("%s: fetching %s failed: %s", self.source, obj.key, e)
            return e
        if got is None:
            return None
        try:
            return parse(self.source, obj.key, got[0])
        except Invalid as e:
            return e

    def ingest(self, obj, version: int, parsed: Parsed | Invalid, prev: Row | None = None):
        self.next_id += 1
        fid = self.next_id
        if isinstance(parsed, Invalid):
            self.counts["invalid"] += 1
            self.insert_file(fid, obj, version, None, "invalid", str(parsed)[:500], None, False)
        else:
            h = parsed.content_hash
            fresh = h not in self.holders
            status, reason, by, has_points = self.place(fid, h)
            if fresh:
                self.buffer_points(fid, parsed)
                self.hold(h, fid, status, reason)
            self.counts["new" if status == "active" else "copy"] += 1
            self.insert_file(fid, obj, version, parsed, status, reason, by, has_points)
            if status == "active":
                self.touched.add(fid)
        if prev is not None:
            self.counts["replaced"] += 1
            self.leave(prev.file_id, "superseded", "replaced", fid)

    def changed(self, row: Row, obj, parsed: Parsed | Invalid):
        """A key whose ETag changed, or that came back after a withdrawal."""
        if isinstance(parsed, Parsed) and parsed.content_hash == row.content_hash:
            self.sql("UPDATE lake.files SET etag = ? WHERE file_id = ?", [obj.etag, row.file_id])
            self.counts["etag only"] += 1
            if row.status == "withdrawn":
                self.counts["reactivated"] += 1
                status, reason, by, has_points = self.place(row.file_id, row.content_hash)
                self.set_status(row.file_id, status, reason, by, has_points)
                if status == "active":
                    self.touched.add(row.file_id)
            return
        # Rule 2: a file replaced in place supersedes its old version entirely.
        self.ingest(obj, row.version + 1, parsed, prev=row)

    def place(self, fid: int, h: str):
        """Rule 1: where a file's content already lives. Returns (status, reason, superseded_by, has_points)."""
        holder = self.holders.get(h)
        if holder is None or holder[0] == fid:
            return "active", None, None, True
        holder_id, status, reason = holder
        if status == "active" or reason == "covered":
            return "superseded", "copy", holder_id, False
        # The holder is withdrawn or replaced: this file takes its points over. Their
        # `row` stays the holder's row, which is this file's row only if both list
        # the soundings in the same order.
        self.sql("UPDATE lake.points SET file_id = ? WHERE file_id = ?", [fid, holder_id])
        if holder_id in self.buffer:
            self.buffer[fid] = [(r[0], fid, *r[2:]) for r in self.buffer.pop(holder_id)]
        self.sql("UPDATE lake.files SET has_points = false WHERE file_id = ?", [holder_id])
        del self.hash_of[holder_id]
        self.hold(h, fid, "active", None)
        return "active", None, None, True

    def leave(self, fid: int, status: str, reason: str | None, by: int | None):
        """A file left its source or was replaced: files that deferred to it come back."""
        self.set_status(fid, status, reason, by)
        for dep, dep_reason, h in self.sql(
            """SELECT file_id, reason, content_hash FROM lake.files
            WHERE superseded_by = ? AND status = 'superseded' AND reason IN ('copy', 'covered')""",
            [fid],
        ).fetchall():
            if dep_reason == "copy":
                self.set_status(dep, *self.place(dep, h))
            else:
                self.set_status(dep, "active", None, None)
            self.touched.add(dep)

    def set_status(self, fid, status, reason, by, has_points=None):
        self.sql(
            """UPDATE lake.files SET status = ?, reason = ?, superseded_by = ?,
            has_points = coalesce(?, has_points) WHERE file_id = ?""",
            [status, reason, by, has_points, fid],
        )
        if fid in self.hash_of:
            self.hold(self.hash_of[fid], fid, status, reason)

    def hold(self, h, fid, status, reason):
        """Record which file holds the points of content hash h."""
        self.holders[h] = (fid, status, reason)
        self.hash_of[fid] = h

    def insert_file(self, fid, obj, version, parsed, status, reason, by, has_points):
        tmin, tmax = parsed.time_range if parsed else (None, None)
        self.sql(
            "INSERT INTO lake.files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                fid, self.source, obj.key, version,
                parsed.file_uuid if parsed else None,
                parsed.vessel if parsed else None,
                obj.etag,
                parsed.content_hash if parsed else None,
                arrival(self.source, obj.key), self.now, tmin, tmax,
                len(parsed.soundings) if parsed else 0,
                has_points, status, reason, by,
            ],
        )  # fmt: skip
        if parsed and parsed.meta:
            m = parsed.meta
            self.sql(
                "INSERT INTO lake.submission_meta VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                [
                    fid, m["depth_reference"], m["position_reference"], m["sounder"],
                    m["sounder_position"], m["gnss_position"], m["draft"], m["logger_version"],
                    m["csb"],
                ],
            )  # fmt: skip

    # Rule 3

    def withdraw(self, subs, current, complete):
        if not complete:
            log.warning("%s: listing incomplete, no withdrawals this run", self.source)
            self.alert = True
            return
        live = [r for r in current.values() if r.status != "withdrawn"]
        missing = {r.key: r for r in live if r.key not in subs}
        active = sum(r.status == "active" for r in live)
        held = {
            key: (seen, confirmed)
            for key, seen, confirmed in self.sql(
                "SELECT key, seen, confirmed FROM lake.withdrawal_holds WHERE source = ? AND starts_with(key, ?)",
                [self.source, self.scope],
            ).fetchall()
        }
        missing_active = sum(r.status == "active" for r in missing.values())
        hold = bool(missing) and (not subs or missing_active > WITHDRAWAL_LIMIT * active)
        apply = list(missing)
        holds = {}
        if hold:
            # Held withdrawals apply once two consecutive listings agree and an operator confirmed them.
            holds = {
                k: (held.get(k, (0, False))[0] + 1, held.get(k, (0, False))[1]) for k in missing
            }
            apply = [k for k, (seen, confirmed) in holds.items() if seen >= 2 and confirmed]
            holds = {k: v for k, v in holds.items() if k not in apply}
            self.alert |= bool(holds)
            self.counts["held withdrawals"] = len(holds)
        if holds:
            log.warning(
                "%s: holding %d withdrawals of %d active files; confirm with `grid confirm-withdrawals %s`",
                self.source, len(holds), active, self.source,
            )  # fmt: skip
        self.sql(
            "DELETE FROM lake.withdrawal_holds WHERE source = ? AND starts_with(key, ?)",
            [self.source, self.scope],
        )
        for key, (seen, confirmed) in holds.items():
            self.sql(
                "INSERT INTO lake.withdrawal_holds VALUES (?, ?, ?, ?)",
                [self.source, key, seen, confirmed],
            )
        for key in apply:
            self.counts["withdrawn"] += 1
            self.leave(missing[key].file_id, "withdrawn", None, None)

    # Rule 4

    def cover(self):
        """A newer file from the same vessel supersedes an older one that it holds every sounding of."""
        for fid in sorted(self.touched):
            found = self.sql(
                "SELECT arrival, time_min, time_max FROM lake.files WHERE file_id = ? AND status = 'active'",
                [fid],
            ).fetchone()
            if not found:
                continue
            arrived, tmin, tmax = found
            for other, other_arrived, omin, omax in self.sql(
                """SELECT o.file_id, o.arrival, o.time_min, o.time_max
                FROM lake.files o JOIN lake.files me
                  ON o.source = me.source AND o.vessel = me.vessel AND o.file_id <> me.file_id
                WHERE me.file_id = ? AND o.status = 'active'
                  AND o.time_min <= me.time_max AND o.time_max >= me.time_min""",
                [fid],
            ).fetchall():
                if (arrived, fid) > (other_arrived, other):
                    newer, older, inside = fid, other, tmin <= omin and omax <= tmax
                else:
                    newer, older, inside = other, fid, omin <= tmin and tmax <= omax
                # A wider time range alone never supersedes: the newer file must hold every sounding.
                if (
                    inside
                    and self.is_active(older)
                    and self.is_active(newer)
                    and self.covers(newer, older)
                ):
                    self.counts["covered"] += 1
                    self.set_status(older, "superseded", "covered", newer)
                    if older == fid:
                        break

    def is_active(self, fid):
        return (
            self.sql("SELECT status FROM lake.files WHERE file_id = ?", [fid]).fetchone()[0]
            == "active"
        )

    def covers(self, newer: int, older: int) -> bool:
        """Every (time, position) of the older file, as many times as it occurs there, is in the newer.

        Counting matters: loggers faster than 1 Hz repeat a time and position with
        different depths, and a newer file holding fewer of them doesn't hold them all.
        """
        # ponytail: scans points by file_id, which neither partitioning nor sorting prunes;
        # sort points by file_id within a batch if overlapping files become common
        return self.sql(
            """SELECT NOT EXISTS (
              SELECT 1
              FROM (SELECT time, lon, lat, count(*) AS n FROM lake.points
                    WHERE file_id = $older GROUP BY ALL) a
              LEFT JOIN (SELECT time, lon, lat, count(*) AS n FROM lake.points
                    WHERE file_id = $newer GROUP BY ALL) b USING (time, lon, lat)
              WHERE b.n IS NULL OR b.n < a.n)""",
            {"older": older, "newer": newer},
        ).fetchone()[0]

    # Points

    def buffer_points(self, fid: int, parsed: Parsed):
        h = parsed.content_hash
        self.buffer[fid] = [
            (
                point_id(h, i), fid, i, s.unique_id, s.platform, s.provider, s.time, s.time_raw,
                s.lon, s.lat, s.depth, tile_id(s.lon, s.lat), cell_id(s.lon, s.lat),
                self.batch_id, morton(s.lon, s.lat),
            )
            for i, s in enumerate(parsed.soundings)
        ]  # fmt: skip

    def flush(self):
        rows = [r for fid in sorted(self.buffer) for r in self.buffer[fid]]
        self.buffer = {}
        if not rows:
            return
        names = "point_id file_id row unique_id platform provider time time_raw lon lat depth_raw tile_id cell_id batch_id sfc"
        types = [
            pa.binary(), pa.int64(), pa.int32(), pa.string(), pa.string(), pa.string(),
            pa.timestamp("us"), pa.string(), pa.float64(), pa.float64(), pa.float32(),
            pa.int32(), pa.int16(), pa.int64(), pa.uint32(),
        ]  # fmt: skip
        columns = list(zip(*rows))
        batch = pa.table({n: pa.array(c, t) for n, c, t in zip(names.split(), columns, types)})
        self.con.register("batch", batch)
        # Sorted by tile, then Z-order, so row-group statistics prune reads to a few tiles.
        self.sql("INSERT INTO lake.points SELECT * EXCLUDE (sfc) FROM batch ORDER BY tile_id, sfc")
        self.con.unregister("batch")
        self.counts["points"] += len(rows)

    # NOAA's response, recorded but not used to decide anything

    def record_responses(self):
        for fid, key in self.sql(
            """SELECT f.file_id, f.key FROM lake.files f JOIN lake.submission_meta m USING (file_id)
            WHERE f.source = 'openwaters' AND m.noaa_response IS NULL AND starts_with(f.key, ?)""",
            [self.scope],
        ).fetchall():
            stem = key.removesuffix(".geojson")
            sidecar = next((stem + s for s in SIDECARS if stem + s in self.sidecars), None)
            try:
                got = sidecar and self.objects.get(sidecar)
            except (BotoCoreError, ClientError, OSError) as e:
                # Left missing, so the next run reads it again.
                log.warning("%s: fetching %s failed: %s", self.source, sidecar, e)
                self.counts["fetch errors"] += 1
                self.alert = True
                continue
            if got:
                self.sql(
                    "UPDATE lake.submission_meta SET noaa_response = ? WHERE file_id = ?",
                    [got[0].decode(errors="replace"), fid],
                )


def confirm_withdrawals(con, source: str) -> int:
    return con.execute(
        "UPDATE lake.withdrawal_holds SET confirmed = true WHERE source = ?", [source]
    ).fetchone()[0]
