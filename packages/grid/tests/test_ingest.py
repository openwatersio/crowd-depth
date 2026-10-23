import json
import random
import shutil
import time
import uuid
from datetime import UTC, datetime, timedelta

import duckdb
import pytest
from boto3.exceptions import RetriesExceededError

from grid import catalog, ingest, sources
from grid.catalog import LOCK, POINTER, Lock, Locked, open_store
from grid.ingest import Ingest, confirm_withdrawals
from grid.objects import Conflict, LocalObjects
from grid.sources import Invalid, is_submission, load

VESSEL = "b0a6561e-970b-48d2-8a17-5862e6a795bc"
OTHER = "5e2f1c3a-6d4b-4f8e-9a1c-2b7d3e4f5a6b"
HEADER = "UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME,PLATFORM_NAME,PROVIDER\n"


def noaa_csv(rows, unique_id="AQM-1", file_uuid="f1"):
    """rows: (second, lon, lat, depth)"""
    return (
        HEADER
        + "".join(
            f'{unique_id},{file_uuid},{lon},{lat},{d},"2026-10-13T18:00:{s:02d}Z",Anonymous,AquaMap\n'
            for s, lon, lat, d in rows
        )
    ).encode()


def noaa_key(n):
    return f"csb/csv/2026/10/14/2026101400000{n}000000_{n}_pointData.csv"


def geojson(rows, vessel=VESSEL, body_vessel=None):
    vid = "SIGNALK-" + (body_vessel or vessel)
    return json.dumps(
        {
            "type": "FeatureCollection",
            "properties": {
                "trustedNode": {"uniqueVesselID": vid, "verticalReferenceOfDepth": "Waterline"},
                "platform": {"uniqueID": vid, "name": "Cerulean"},
            },
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {"depth": d, "time": f"2026-10-13T18:00:{s:02d}.000Z"},
                }
                for s, lon, lat, d in rows
            ],
        }
    ).encode()


def ow_key(minute, vessel=VESSEL):
    return f"2026/10/14/00:{minute:02d}:00.000Z-{vessel}.geojson"


ROWS = [(1, -78.1, 33.1, 4.8), (2, -78.2, 33.2, 5.0), (3, -78.3, 33.3, 5.2)]


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest, "WITHDRAWAL_LIMIT", 0.5)
    noaa, ow, store = (LocalObjects(tmp_path / d) for d in ("noaa", "ow", "store"))

    def run(*sources, now=None):
        with open_store(store) as con:
            alerts = [
                Ingest(con, s, noaa if s == "noaa" else ow, now=now).run().alert
                for s in sources or ("noaa", "openwaters")
            ]
        return any(alerts)

    def query(sql, params=None):
        with open_store(store, write=False) as con:
            return con.execute(sql, params or []).fetchall()

    def files():
        return {
            k: (s, r)
            for k, s, r in query(
                "SELECT key, status, reason FROM lake.files QUALIFY row_number() OVER (PARTITION BY key ORDER BY version DESC) = 1"
            )
        }

    def active():
        return sorted(query("SELECT unique_id, time, depth_raw FROM active_points"))

    class Env:
        pass

    e = Env()
    e.noaa, e.ow, e.store, e.run, e.query, e.files, e.active = (
        noaa,
        ow,
        store,
        run,
        query,
        files,
        active,
    )
    return e


def parse(source, key, body, tmp_path):
    """Load a body through the ingest loader, as ingest does from its download."""
    path = tmp_path / "body"
    path.write_bytes(body)
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    return load(con, source, key, str(path))


def test_content_hash_ignores_file_uuid_and_order(tmp_path):
    a = parse("noaa", noaa_key(1), noaa_csv(ROWS, file_uuid="one"), tmp_path)
    b = parse("noaa", noaa_key(1), noaa_csv(list(reversed(ROWS)), file_uuid="two"), tmp_path)
    c = parse("noaa", noaa_key(1), noaa_csv(ROWS[:2] + [(3, -78.3, 33.3, 5.3)]), tmp_path)
    assert a.content_hash == b.content_hash
    assert a.content_hash != c.content_hash
    # A repeated sounding is part of the content: the hash is a multiset's, not a set's.
    d = parse("noaa", noaa_key(1), noaa_csv(ROWS + ROWS[:1]), tmp_path)
    assert d.content_hash != a.content_hash


def test_validity(tmp_path):
    for body in (
        noaa_csv([(1, -78.1, 95.0, 4.8)]),
        b"UNIQUE_ID,LON\nx,1\n",
        noaa_csv([(1, -78.1, 33.0, "nan")]),
        noaa_csv([(1, -78.1, 33.0, 1e39)]),  # overflows float32
        HEADER.encode(),
        b"\xff\xfe",
        noaa_csv(ROWS).replace(b'Z"', b'"'),  # times without a zone
    ):
        with pytest.raises(Invalid):
            parse("noaa", noaa_key(1), body, tmp_path)
    deep = b"[" * 100_000 + b"]" * 100_000
    for body in (b"[]", b"{", deep, geojson([(1, -78.1, 33.0, 1e39)]), b'{"features": 5}'):
        with pytest.raises(Invalid):
            parse("openwaters", ow_key(1), body, tmp_path)
    blank = noaa_csv(ROWS[:1]) + noaa_csv(ROWS[1:2], unique_id="")[len(HEADER) :]
    with pytest.raises(Invalid, match="without a UNIQUE_ID"):
        parse("noaa", noaa_key(1), blank, tmp_path)
    with pytest.raises(Invalid):  # a date alone has no time of day or zone
        parse("noaa", noaa_key(1), noaa_csv(ROWS).replace(b'T18:00:01Z"', b'"'), tmp_path)
    # A row with an extra field still reads.
    extra = noaa_csv(ROWS).replace(b"AquaMap\n", b"AquaMap,extra\n", 1)
    assert parse("noaa", noaa_key(1), extra, tmp_path).count == 3
    # A zone of hours alone is still a zone.
    hours = noaa_csv(ROWS).replace(b'Z"', b'+00"')
    assert parse("noaa", noaa_key(1), hours, tmp_path).count == 3
    # Sentinels are QC's business, not invalid files.
    assert parse("noaa", noaa_key(1), noaa_csv([(1, -78.1, 33.0, -1e9)]), tmp_path).count == 1


def test_malformed_metadata_is_dropped_not_fatal(env):
    doc = json.loads(geojson(ROWS))
    doc["properties"]["trustedNode"] = "Open Waters"
    doc["properties"]["platform"]["sensors"] = [
        "x",
        {"type": "Sounder", "make": 5, "position": [{"x": 1}], "draft": "abc"},
        {"type": "GNSS", "position": ["1", "2", "3"], "draft": 1e400},
    ]
    env.ow.put(ow_key(1), json.dumps(doc).encode())
    env.ow.put(ow_key(1).replace(".geojson", ".done.json"), b"{truncated")
    env.run("openwaters")
    assert env.files()[ow_key(1)] == ("active", None)
    assert env.query(
        "SELECT sounder, sounder_position, gnss_position, draft, noaa_response "
        "FROM lake.submission_meta"
    ) == [(None, None, None, None, "{truncated")]


def test_keys_with_impossible_dates_are_skipped():
    assert not is_submission("noaa", "csb/csv/2026/13/45/20261345000000000000_a_pointData.csv")
    assert not is_submission("openwaters", ow_key(1).replace("2026/10/14", "2026/02/30"))
    assert is_submission("noaa", noaa_key(1)) and is_submission("openwaters", ow_key(1))


@pytest.mark.parametrize("error", [OSError("reset"), RetriesExceededError(OSError("reset"))])
def test_fetch_errors_skip_the_file_until_next_run(env, monkeypatch, error):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    download = env.noaa.download
    monkeypatch.setattr(env.noaa, "download", lambda key, path: (_ for _ in ()).throw(error))
    assert env.run("noaa")
    assert env.files() == {}
    monkeypatch.setattr(env.noaa, "download", download)
    assert not env.run("noaa")
    assert env.files() == {noaa_key(1): ("active", None)}


def test_max_files_bounds_a_run(env):
    for n in (1, 2, 3):
        env.noaa.put(noaa_key(n), noaa_csv(ROWS, unique_id=f"AQM-{n}"))
    with open_store(env.store) as con:
        Ingest(con, "noaa", env.noaa, max_files=2).run()
    assert len(env.files()) == 2
    env.run("noaa")
    assert len(env.files()) == 3


def test_file_ids_and_rows_are_stable(env, tmp_path):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    env.run("noaa")
    ids = env.query('SELECT file_id, "row" FROM lake.points ORDER BY "row"')
    other = LocalObjects(tmp_path / "other")
    with open_store(other) as con:
        Ingest(con, "noaa", env.noaa).run()
        assert (
            con.execute('SELECT file_id, "row" FROM lake.points ORDER BY "row"').fetchall() == ids
        )
    assert len(set(ids)) == 3
    assert ids == [(1, 0), (1, 1), (1, 2)]


def test_implausible_times_stay_out_of_file_spans(env):
    """A GPS logging 1970 before its fix, or a far-future year, is QC's to reject; the
    file's span (and the dedupe it drives) covers only its plausible times."""
    body = geojson(ROWS).replace(b"2026-10-13T18:00:01", b"1970-01-01T00:00:00")
    env.ow.put(ow_key(1), body.replace(b"2026-10-13T18:00:03", b"2099-01-01T00:00:00"))
    env.ow.put(ow_key(2), geojson(ROWS).replace(b"2026-10-13T18:00:03", b"294247-01-10T04:00:54"))
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, unique_id="SIGNALK-" + VESSEL))
    env.run()
    assert env.files()[ow_key(2)] == ("invalid", "1 impossible times")
    spans = env.query("SELECT time_min, time_max FROM lake.files WHERE key = ?", [ow_key(1)])
    assert spans == [(datetime(2026, 10, 13, 18, 0, 2), datetime(2026, 10, 13, 18, 0, 2))]
    # Rule 5 drops only NOAA's sounding at 18:00:02; the OW file keeps all three.
    assert len(env.active()) == 5


def test_rule1_copies_are_skipped(env):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, file_uuid="a"))
    env.noaa.put(noaa_key(2), noaa_csv(ROWS, file_uuid="b"))
    env.run("noaa")
    assert env.files() == {noaa_key(1): ("active", None), noaa_key(2): ("superseded", "copy")}
    assert len(env.active()) == 3
    assert env.query("SELECT count(*) FROM lake.points") == [(3,)]


def test_rule1_copy_takes_over_when_original_withdrawn(env):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, file_uuid="a"))
    env.noaa.put(noaa_key(2), noaa_csv(ROWS, file_uuid="b"))
    env.noaa.put(noaa_key(3), noaa_csv(ROWS, unique_id="AQM-2"))
    env.run("noaa")
    env.noaa.delete(noaa_key(1))
    env.run("noaa")
    assert env.files()[noaa_key(1)] == ("withdrawn", None)
    assert env.files()[noaa_key(2)] == ("active", None)
    assert len(env.active()) == 6
    assert env.query("SELECT count(*) FROM lake.points") == [(6,)]


def test_rule2_replacement_supersedes_old_version(env):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    env.run("noaa")
    env.noaa.put(noaa_key(1), noaa_csv(ROWS[:2]))  # reprocessing dropped a point
    env.run("noaa")
    assert env.query("SELECT version, status, reason FROM lake.files ORDER BY version") == [
        (1, "superseded", "replaced"),
        (2, "active", None),
    ]
    assert len(env.active()) == 2


def test_rule2_same_content_keeps_row(env):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, file_uuid="a"))
    env.run("noaa")
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, file_uuid="b"))
    env.run("noaa")
    assert env.query("SELECT version, status, etag FROM lake.files") == [
        (1, "active", env.noaa.get(noaa_key(1))[1])
    ]


def test_rule3_withdrawal_and_return(env):
    for n in (1, 2, 3):
        env.noaa.put(noaa_key(n), noaa_csv(ROWS, unique_id=f"AQM-{n}"))
    env.run("noaa")
    ids_sql = 'SELECT file_id, "row" FROM lake.points WHERE unique_id = \'AQM-1\' ORDER BY "row"'
    ids = env.query(ids_sql)
    body = env.noaa.get(noaa_key(1))[0]
    env.noaa.delete(noaa_key(1))
    assert not env.run("noaa")
    assert env.files()[noaa_key(1)] == ("withdrawn", None)
    assert len(env.active()) == 6
    env.noaa.put(noaa_key(1), body)
    env.run("noaa")
    assert env.query("SELECT file_id, status FROM lake.files WHERE key = ?", [noaa_key(1)]) == [
        (1, "active")
    ]
    assert env.query(ids_sql) == ids


def test_withdrawal_guard_holds_until_two_listings_agree_and_confirmed(env):
    for n in (1, 2):
        env.noaa.put(noaa_key(n), noaa_csv(ROWS, unique_id=f"AQM-{n}"))
    env.run("noaa")
    env.noaa.delete(noaa_key(1))
    env.noaa.delete(noaa_key(2))  # an empty listing withdraws nothing
    assert env.run("noaa")
    assert env.run("noaa")
    assert {s for s, _ in env.files().values()} == {"active"}
    with open_store(env.store) as con:
        assert confirm_withdrawals(con, "noaa") == 2
    assert not env.run("noaa")  # nothing left held
    assert {s for s, _ in env.files().values()} == {"withdrawn"}


def test_withdrawal_guard_share_and_reappearance(env, monkeypatch):
    monkeypatch.setattr(ingest, "WITHDRAWAL_LIMIT", 0.01)
    for n in (1, 2):
        env.noaa.put(noaa_key(n), noaa_csv(ROWS, unique_id=f"AQM-{n}"))
    env.run("noaa")
    body = env.noaa.get(noaa_key(1))[0]
    env.noaa.delete(noaa_key(1))
    assert env.run("noaa")  # 1 of 2 is over 1%
    assert env.query("SELECT key, seen FROM lake.withdrawal_holds") == [(noaa_key(1), 1)]
    env.noaa.put(noaa_key(1), body)
    assert not env.run("noaa")
    assert env.query("SELECT count(*) FROM lake.withdrawal_holds") == [(0,)]


def test_incomplete_listing_withdraws_nothing(env, monkeypatch):
    for n in (1, 2, 3):
        env.noaa.put(noaa_key(n), noaa_csv(ROWS, unique_id=f"AQM-{n}"))
    env.run("noaa")
    env.noaa.delete(noaa_key(1))
    listing = env.noaa.list
    monkeypatch.setattr(env.noaa, "list", lambda prefix="": (listing(prefix)[0], False))
    assert env.run("noaa")
    assert env.files()[noaa_key(1)] == ("active", None)


def test_the_flush_runs_on_one_thread_and_publish_keeps_the_rest(tmp_path):
    seen = []
    with open_store(LocalObjects(tmp_path / "store")) as con:

        class Spy:
            def execute(self, sql, *args):
                if sql.startswith("CALL ducklake_flush_inlined_data"):
                    seen.append(con.execute("SELECT current_setting('threads')").fetchone()[0])
                return con.execute(sql, *args)

        catalog.flush_inlined(Spy())
        assert seen == [1]
        con.execute("SET threads = 3")
        con.publish()
        assert con.execute("SELECT current_setting('threads')").fetchone()[0] == 3


def test_a_run_that_fails_keeps_what_it_published(env, monkeypatch):
    # Every file is a checkpoint; the third file can't be downloaded, as an R2 error
    # late in a long import.
    # Batches stay under FLUSH_POINTS, so checkpoints fall between them.
    monkeypatch.setattr(catalog, "CHECKPOINT_SECONDS", 0)
    monkeypatch.setattr(ingest, "FETCH_BYTES", 1)
    env.ow.put(ow_key(1), geojson(ROWS[:2]))
    env.ow.put(ow_key(2), geojson(ROWS))  # covers the first
    env.ow.put(ow_key(3, OTHER), geojson(ROWS, OTHER))
    download = env.ow.download

    def flaky(key, path):
        if key == ow_key(3, OTHER):
            raise RuntimeError("RequestTimeTooSkewed")
        return download(key, path)

    monkeypatch.setattr(env.ow, "download", flaky)
    with pytest.raises(RuntimeError):
        env.run("openwaters")
    assert env.files() == {ow_key(1): ("superseded", "covered"), ow_key(2): ("active", None)}
    assert len(env.active()) == 3
    monkeypatch.setattr(env.ow, "download", download)
    fetched = []
    monkeypatch.setattr(env.ow, "download", lambda k, p: fetched.append(k) or download(k, p))
    env.run("openwaters")
    assert fetched == [ow_key(3, OTHER)]
    assert env.files()[ow_key(3, OTHER)] == ("active", None)
    assert len(env.active()) == 6


def test_rule4_newer_file_holding_every_sounding_supersedes(env):
    env.ow.put(ow_key(1), geojson(ROWS[:2]))
    env.ow.put(ow_key(2), geojson(ROWS))  # a retry covering the same soundings, and more
    env.run("openwaters")
    assert env.files() == {ow_key(1): ("superseded", "covered"), ow_key(2): ("active", None)}
    assert len(env.active()) == 3


def test_rule4_wider_range_with_gap_keeps_both_and_counts_once(env):
    env.ow.put(ow_key(1), geojson(ROWS))
    env.ow.put(ow_key(2), geojson([ROWS[0], ROWS[2], (4, -78.4, 33.4, 5.4)]))  # gap at second 2
    env.run("openwaters")
    assert {s for s, _ in env.files().values()} == {"active"}
    assert [t.second for _, t, _ in env.active()] == [1, 2, 3, 4]


def test_rule4_needs_every_repeat_of_a_time_and_position(env):
    # A logger faster than 1 Hz: two soundings in one second at one position.
    older = [(1, -78.1, 33.1, 2.0), (1, -78.1, 33.1, 3.0), (2, -78.2, 33.2, 5.0)]
    env.ow.put(ow_key(1), geojson(older))
    env.ow.put(ow_key(2), geojson(older[1:]))
    env.run("openwaters")
    assert {s for s, _ in env.files().values()} == {"active"}
    assert 2.0 in [d for _, _, d in env.active()]


def test_rule4_older_file_arriving_late_is_covered(env):
    env.ow.put(ow_key(2), geojson(ROWS))
    env.run("openwaters")
    env.ow.put(ow_key(1), geojson(ROWS[:2]))
    env.run("openwaters")
    assert env.files() == {ow_key(1): ("superseded", "covered"), ow_key(2): ("active", None)}


def test_rule4_reads_points_once_however_many_files_overlap(env, monkeypatch):
    # Six retries of one track, each a little longer: every pair nests in time.
    for n in range(1, 7):
        env.ow.put(ow_key(n), geojson([(s, -78 - s / 100, 33.1, 5.0) for s in range(1, n + 2)]))
    queries = []
    sql = Ingest.sql
    monkeypatch.setattr(Ingest, "sql", lambda self, q, p=None: queries.append(q) or sql(self, q, p))
    env.run("openwaters")
    assert sum("FROM lake.points" in q and "GROUP BY ALL" in q for q in queries) == 1
    assert sum("JOIN lake.files o" in q for q in queries) == 1
    assert [s for s, _ in env.files().values()].count("active") == 1


class PerPairCover(Ingest):
    """Rule 4 as it ran per file and per pair, with the pairs in file_id order."""

    def cover(self):
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
                  AND o.time_min <= me.time_max AND o.time_max >= me.time_min
                ORDER BY o.file_id""",
                [fid],
            ).fetchall():
                if (arrived, fid) > (other_arrived, other):
                    newer, older, inside = fid, other, tmin <= omin and omax <= tmax
                else:
                    newer, older, inside = other, fid, omin <= tmin and tmax <= omax
                active = lambda f: (
                    self.sql("SELECT status FROM lake.files WHERE file_id = ?", [f]).fetchone()[0]
                    == "active"
                )
                if (
                    inside
                    and active(older)
                    and active(newer)
                    and self.holding({(newer, older)}, {newer: 0, older: 0})
                ):
                    self.counts["covered"] += 1
                    self.set_status(older, "superseded", "covered", newer)
                    if older == fid:
                        break


@pytest.mark.parametrize("seed", range(5))
def test_rule4_matches_judging_each_pair_in_turn(tmp_path, monkeypatch, seed):
    # Retries, partial copies and fast-logger repeats of a few vessels' tracks, arriving
    # over two runs, judged in groups small enough to split them.
    rng = random.Random(seed)
    monkeypatch.setattr(ingest, "COVER_POINTS", 12)
    track = [(s, -78 - s / 100, 33.1, 5.0) for s in range(1, 12)]
    vessels = [str(uuid.UUID(int=rng.getrandbits(128))) for _ in range(2)]
    uploads = []
    for minute in range(1, 13):
        lo, hi = sorted(rng.sample(range(len(track) + 1), 2))
        rows = track[lo:hi] or track[:1]
        if rng.random() < 0.3:
            rows = rows[:-1] if len(rows) > 1 else rows
            rows = rows[: len(rows) // 2] + rows[len(rows) // 2 + 1 :] or rows
        if rng.random() < 0.2:
            rows = rows + [rng.choice(rows)]
        vessel = rng.choice(vessels)
        uploads.append((ow_key(minute, vessel), geojson(rows, vessel)))
    results = []
    for cls in (Ingest, PerPairCover):
        ow, store = (
            LocalObjects(tmp_path / cls.__name__ / "ow"),
            LocalObjects(tmp_path / cls.__name__ / "store"),
        )
        for half in (uploads[::2], uploads[1::2]):
            for key, body in half:
                ow.put(key, body)
            with open_store(store) as con:
                cls(con, "openwaters", ow).run()
        with open_store(store, write=False) as con:
            results.append(
                con.execute(
                    "SELECT key, status, reason, superseded_by FROM lake.files ORDER BY key"
                ).fetchall()
            )
    assert results[0] == results[1]
    assert any(r[2] == "covered" for r in results[0])


def test_rule4_covered_file_returns_when_newer_withdrawn(env, monkeypatch):
    monkeypatch.setattr(ingest, "WITHDRAWAL_LIMIT", 1)
    env.ow.put(ow_key(1), geojson(ROWS[:2]))
    env.ow.put(ow_key(2), geojson(ROWS))
    env.run("openwaters")
    env.ow.delete(ow_key(2))
    env.run("openwaters")
    assert env.files() == {ow_key(1): ("active", None), ow_key(2): ("withdrawn", None)}


def test_rule5_noaa_soundings_inside_openwaters_span_are_dropped(env):
    env.ow.put(ow_key(1), geojson(ROWS[:2]))  # seconds 1-2
    env.noaa.put(
        noaa_key(1),
        noaa_csv(
            [(1, -78.1, 33.1, 4.8), (2, -78.2, 33.2, 5.0), (5, -78.5, 33.5, 5.5)],
            "SIGNALK-" + VESSEL,
        ),
    )
    env.noaa.put(noaa_key(2), noaa_csv(ROWS))  # another vessel
    env.run()
    points = env.query(
        "SELECT source, time FROM active_points WHERE unique_id = ? ORDER BY time",
        ["SIGNALK-" + VESSEL],
    )
    assert [(s, t.second) for s, t in points] == [("openwaters", 1), ("openwaters", 2), ("noaa", 5)]
    assert len(env.active()) == 6


def test_a_vessel_filter_keeps_that_vessels_active_points_alone(env):
    env.ow.put(ow_key(1), geojson(ROWS[:2]))
    env.noaa.put(
        noaa_key(1),
        noaa_csv([(1, -78.1, 33.1, 4.8), (5, -78.5, 33.5, 5.5)], "SIGNALK-" + VESSEL),
    )
    env.noaa.put(noaa_key(2), noaa_csv(ROWS))
    env.noaa.put(noaa_key(3), noaa_csv(ROWS))  # an overlapping copy, deduped
    env.run()
    [(cell,)] = env.query("SELECT DISTINCT cell_id FROM lake.points")
    columns = "source, unique_id, time, depth_raw, file_id"
    for vessel in {v for (v,) in env.query("SELECT DISTINCT unique_id FROM lake.points")}:
        expected = env.query(
            f"SELECT {columns} FROM active_points WHERE unique_id = ? ORDER BY ALL", [vessel]
        )
        for macro in ("active_points_in", "corrected_points_in"):
            got = env.query(
                f"SELECT {columns} FROM {macro}(?, [], 0, 10800, vessels := [?]) ORDER BY ALL",
                [cell, vessel],
            )
            assert expected and got == expected


def test_vessel_identity_comes_from_key(env):
    env.ow.put(ow_key(1), geojson(ROWS, body_vessel="0d00140f-0371-4208-a099-cf2f76e557e3"))
    env.ow.put(ow_key(2), geojson(ROWS))
    env.ow.put(ow_key(2).replace(".geojson", ".done.json"), b'{"success": true}')
    env.run("openwaters")
    assert env.files()[ow_key(1)][0] == "invalid"
    assert env.query("SELECT DISTINCT unique_id FROM lake.points") == [("SIGNALK-" + VESSEL,)]
    assert env.query("SELECT depth_reference, noaa_response FROM lake.submission_meta") == [
        ("Waterline", '{"success": true}')
    ]


def lock_free(store):
    got = store.get(LOCK)
    return got is None or datetime.fromisoformat(json.loads(got[0])["expires"]) <= datetime.now(UTC)


def test_a_released_lock_is_taken_without_a_stale_warning(tmp_path, caplog):
    store = LocalObjects(tmp_path)
    with open_store(store):
        pass
    with caplog.at_level("WARNING"), open_store(store):
        pass
    assert "stale" not in caplog.text
    # A run that crashed without releasing.
    store.put(
        LOCK, json.dumps({"owner": "crashed", "expires": "2000-01-01T00:00:00+00:00"}).encode()
    )
    with caplog.at_level("WARNING"), open_store(store):
        pass
    assert "taking over stale lock from crashed" in caplog.text


@pytest.mark.parametrize("held", [None, "stale"])
def test_lock_and_catalog_puts_whose_responses_were_lost_still_succeed(tmp_path, monkeypatch, held):
    store = LocalObjects(tmp_path)
    if held:
        store.put(LOCK, json.dumps({"owner": "x", "expires": "2000-01-01T00:00:00+00:00"}).encode())
    put = store.put
    failed = set()

    def lost(key, data, **kw):
        etag = put(key, data, **kw)
        if key not in failed and (key == LOCK or key.endswith(".ducklake")):
            failed.add(key)
            raise Conflict(key)  # the retry of a put that landed
        return etag

    monkeypatch.setattr(store, "put", lost)
    with open_store(store) as con:
        con.execute("INSERT INTO lake.withdrawal_holds VALUES ('noaa', 'k', 1, false)")
    with open_store(store, write=False) as con:
        assert con.execute("SELECT count(*) FROM lake.withdrawal_holds").fetchone() == (1,)


def test_a_pointer_move_whose_response_was_lost_still_succeeds(tmp_path, monkeypatch):
    store = LocalObjects(tmp_path)
    with open_store(store):
        pass
    put = store.put

    def lost(key, data, **kw):
        etag = put(key, data, **kw)
        if key == POINTER:
            raise Conflict(key)  # the retry of a put that landed
        return etag

    monkeypatch.setattr(store, "put", lost)
    with open_store(store):
        pass
    assert store.get(POINTER)[0].decode().endswith(".ducklake")


def test_the_catalog_a_run_started_from_outlives_it(tmp_path, monkeypatch):
    # A reader may have read the pointer just before the run moved it.
    monkeypatch.setattr(catalog, "RETAIN", timedelta(0))
    store = LocalObjects(tmp_path)
    with open_store(store):
        pass
    first = store.get(POINTER)[0].decode()
    with open_store(store):
        pass
    assert store.get(first) is not None
    with open_store(store):
        pass
    assert store.get(first) is None


def test_a_store_path_with_a_quote(tmp_path):
    store = LocalObjects(tmp_path / "o'brien")
    with open_store(store) as con:
        con.execute("INSERT INTO lake.withdrawal_holds VALUES ('noaa', 'k', 1, false)")
    with open_store(store, write=False) as con:
        assert con.execute("SELECT count(*) FROM lake.withdrawal_holds").fetchone() == (1,)


def test_a_lock_that_expired_while_renewals_failed_is_lost(tmp_path, monkeypatch):
    # Renewals fail, and the lock object still names this run but has expired: another
    # run may take it over, so this one must stop treating it as held.
    store = LocalObjects(tmp_path)
    lock = Lock(store, ttl=timedelta(seconds=0.4))
    lock.acquire()
    put = store.put
    body = {"owner": lock.owner, "expires": "2000-01-01T00:00:00+00:00"}
    put(LOCK, json.dumps(body).encode())

    def failing(key, data, **kw):
        if key == LOCK:
            raise ConnectionError("R2 unreachable")
        return put(key, data, **kw)

    monkeypatch.setattr(store, "put", failing)
    assert lock.lost.wait(2)
    lock.release()


def test_a_local_listing_walks_only_its_prefix(tmp_path, monkeypatch):
    store = LocalObjects(tmp_path)
    for key in ("a/1/x.csv", "a/12/y.csv", "a/2/z.csv", "b/w.csv"):
        store.put(key, b"data")
    walked = []
    rglob = type(tmp_path).rglob
    monkeypatch.setattr(
        type(tmp_path), "rglob", lambda self, p: walked.append(self) or rglob(self, p)
    )
    assert [o.key for o in store.list("a/1/")[0]] == ["a/1/x.csv"]
    assert [o.key for o in store.list("a/1")[0]] == ["a/1/x.csv", "a/12/y.csv"]
    assert [o.key for o in store.list("")[0]] == ["a/1/x.csv", "a/12/y.csv", "a/2/z.csv", "b/w.csv"]
    assert store.list("c/")[0] == []
    assert walked[:3] == [tmp_path / "a/1", tmp_path / "a", tmp_path]


def test_the_r2_retry_settings_are_ones_duckdb_knows():
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs")
    for setting in catalog.HTTP_RETRIES:
        con.execute(setting)
    assert con.execute("SELECT current_setting('http_retries')").fetchone() == (8,)


def test_a_copied_store_reads_and_writes_its_own_files(env, tmp_path):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    env.run("noaa")
    copy = LocalObjects(tmp_path / "copy")
    shutil.copytree(env.store.root, copy.root)
    with open_store(copy) as con:
        assert con.execute("SELECT count(*) FROM lake.points").fetchone() == (3,)
        con.execute("INSERT INTO lake.withdrawal_holds VALUES ('noaa', 'k', 1, false)")
    with open_store(env.store, write=False) as con:  # the original is untouched
        assert con.execute("SELECT count(*) FROM lake.withdrawal_holds").fetchone() == (0,)


def test_release_never_clobbers_a_lock_taken_over(tmp_path):
    store = LocalObjects(tmp_path)
    lock = Lock(store)
    lock.acquire()
    lock._stop.set()  # stalls past its expiry...
    lock._thread.join()
    other = json.dumps({"owner": "other", "expires": "2999-01-01T00:00:00+00:00"}).encode()
    store.put(LOCK, other)  # ...and another run takes the lock over
    lock.release()
    assert store.get(LOCK)[0] == other


def test_released_lock_can_be_taken(tmp_path):
    store = LocalObjects(tmp_path)
    a = Lock(store)
    a.acquire()
    a.release()
    b = Lock(store)
    b.acquire()
    b.release()


def test_unknown_keys_hold_withdrawals(env):
    for n in (1, 2, 3):
        env.noaa.put(noaa_key(n), noaa_csv(ROWS, unique_id=f"AQM-{n}"))
    env.run("noaa")
    body = env.noaa.get(noaa_key(1))[0]
    env.noaa.delete(noaa_key(1))
    env.noaa.put("csb/csv/2026/10/14/renamed.csv", body)
    assert env.run("noaa")
    assert env.files()[noaa_key(1)] == ("active", None)


def test_lock_is_exclusive_and_stale_locks_are_taken(tmp_path):
    store = LocalObjects(tmp_path)
    a = Lock(store)
    a.acquire()
    with pytest.raises(Locked):
        Lock(store).acquire()
    a._stop.set()  # a stops renewing
    a._thread.join()
    body = json.loads(store.get(LOCK)[0])
    body["expires"] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    store.put(LOCK, json.dumps(body).encode())
    b = Lock(store)
    b.acquire()
    assert json.loads(store.get(LOCK)[0])["owner"] == b.owner
    b.release()
    assert lock_free(store)


def test_lock_renewal_survives_a_retried_renewal(tmp_path):
    store = LocalObjects(tmp_path)
    lock = Lock(store, ttl=timedelta(seconds=0.2))
    lock.acquire()
    lock.etag = "stale"  # as if a renewal landed but its response was lost
    time.sleep(0.2)
    assert not lock.lost.is_set()
    assert json.loads(store.get(LOCK)[0])["owner"] == lock.owner
    store.put(LOCK, json.dumps({"owner": "other", "expires": "2999-01-01T00:00:00+00:00"}).encode())
    time.sleep(0.2)
    assert lock.lost.is_set()
    lock.release()


def test_a_run_that_lost_its_lock_publishes_nothing(tmp_path):
    store = LocalObjects(tmp_path)
    with open_store(store):
        pass
    first = store.get(POINTER)[0]
    other = json.dumps({"owner": "other", "expires": "2999-01-01T00:00:00+00:00"}).encode()
    with pytest.raises(Locked), open_store(store, ttl=timedelta(seconds=0.2)) as con:
        con.execute("INSERT INTO lake.withdrawal_holds VALUES ('noaa', 'k', 1, false)")
        store.put(LOCK, other)  # another run took over a lock this one stopped renewing
        time.sleep(0.2)
    assert store.get(POINTER)[0] == first
    assert store.get(LOCK)[0] == other


def test_read_only_open_publishes_nothing(tmp_path):
    store = LocalObjects(tmp_path)
    with open_store(store):
        pass
    before = store.list("catalog/")
    with open_store(store, write=False) as con:
        assert con.execute("SELECT count(*) FROM lake.files").fetchone() == (0,)
        assert lock_free(store)
    assert store.list("catalog/") == before


def test_pointer_moves_only_from_the_version_the_run_started_from(tmp_path):
    store = LocalObjects(tmp_path)
    with open_store(store):
        pass
    first = store.get(POINTER)[0]
    with pytest.raises(Conflict), open_store(store):
        store.put(POINTER, b"catalog/someone-else.ducklake")
    assert store.get(POINTER)[0] == b"catalog/someone-else.ducklake" != first
    assert lock_free(store)


def test_catalog_survives_reopen(tmp_path):
    store = LocalObjects(tmp_path)
    with open_store(store) as con:
        con.execute("INSERT INTO lake.withdrawal_holds VALUES ('noaa', 'k', 1, false)")
    with open_store(store) as con:
        assert con.execute("SELECT key FROM lake.withdrawal_holds").fetchall() == [("k",)]
    assert catalog.POINTER == "catalog/current"


def test_rule5_identical_noaa_copy_defers_to_openwaters(env):
    # NOAA's CSV of a Signal K submission can hold exactly the soundings sent to R2.
    env.ow.put(ow_key(1), geojson(ROWS))
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, "SIGNALK-" + VESSEL))
    env.run("noaa", "openwaters")
    assert env.files() == {noaa_key(1): ("active", None), ow_key(1): ("active", None)}
    assert {s for (s,) in env.query("SELECT source FROM active_points")} == {"openwaters"}
    assert env.query('SELECT count(DISTINCT (file_id, "row")) FROM lake.points') == [(6,)]


def test_rule5_covers_noaa_seconds_around_millisecond_spans(env):
    doc = json.loads(geojson(ROWS))
    for f, ms in zip(doc["features"], ("600", "100", "900")):
        f["properties"]["time"] = f["properties"]["time"].replace(".000", "." + ms)
    env.ow.put(ow_key(1), json.dumps(doc).encode())
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, "SIGNALK-" + VESSEL))  # whole seconds 1-3
    env.run()
    assert {s for (s,) in env.query("SELECT source FROM active_points")} == {"openwaters"}


def test_alerts_from_fetch_errors_survive_applied_withdrawals(env, monkeypatch):
    monkeypatch.setattr(ingest, "WITHDRAWAL_LIMIT", 1)
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    env.run("noaa")
    env.noaa.delete(noaa_key(1))
    env.noaa.put(noaa_key(2), noaa_csv(ROWS, unique_id="AQM-2"))
    monkeypatch.setattr(
        env.noaa, "download", lambda key, path: (_ for _ in ()).throw(OSError("reset"))
    )
    assert env.run("noaa")


def test_sidecar_fetch_errors_leave_the_response_for_next_run(env, monkeypatch):
    env.ow.put(ow_key(1), geojson(ROWS))
    sidecar = ow_key(1).replace(".geojson", ".done.json")
    env.ow.put(sidecar, b'{"success": true}')
    get = env.ow.get
    monkeypatch.setattr(
        env.ow, "get", lambda key: get(key) if key != sidecar else (_ for _ in ()).throw(OSError())
    )
    assert env.run("openwaters")
    assert env.files() == {ow_key(1): ("active", None)}
    monkeypatch.setattr(env.ow, "get", get)
    env.run("openwaters")
    assert env.query("SELECT noaa_response FROM lake.submission_meta") == [('{"success": true}',)]


def test_unknown_keys_alert_but_hidden_files_do_not(env):
    env.ow.put(ow_key(1), geojson(ROWS))
    env.ow.put("2026/01/.DS_Store", b"")
    assert not env.run("openwaters")
    env.ow.put("2026/10/14/new-layout.geojson", b"{}")
    assert env.run("openwaters")


def test_lock_survives_a_brief_outage(tmp_path, monkeypatch):
    store = LocalObjects(tmp_path)
    lock = Lock(store, ttl=timedelta(seconds=0.4))
    lock.acquire()
    put, get = store.put, store.get
    monkeypatch.setattr(store, "put", lambda *a, **k: (_ for _ in ()).throw(OSError()))
    monkeypatch.setattr(store, "get", lambda *a, **k: (_ for _ in ()).throw(OSError()))
    time.sleep(0.15)  # one failed renewal, well inside the TTL
    monkeypatch.setattr(store, "put", put)
    monkeypatch.setattr(store, "get", get)
    time.sleep(0.25)
    assert not lock.lost.is_set()
    lock.release()
    assert lock_free(store)


def test_stores_record_and_check_their_hash_scheme(tmp_path, monkeypatch):
    store = LocalObjects(tmp_path)
    with open_store(store) as con:
        assert con.execute("SELECT value FROM lake.store_meta WHERE key = 'hash'").fetchall() == [
            (catalog.STORE_SCHEME,)
        ]
    monkeypatch.setattr(catalog, "STORE_SCHEME", "another")
    with pytest.raises(RuntimeError, match="hashes with"), open_store(store, write=False):
        pass


GOLDEN_HASH = "7f1c6278d90a8a3a98d831ac9b6bd4d635c4fe43e85a4dde1d3357043569f45a"


def test_content_hash_is_pinned(tmp_path):
    # Changing this hash means every stored copy stops matching: bump catalog.HASH_SCHEME.
    a = parse("noaa", noaa_key(1), noaa_csv(ROWS), tmp_path)
    assert a.content_hash == GOLDEN_HASH


def test_times_are_stored_in_utc(env):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS).replace(b'18:00:01Z"', b'20:00:01+02:00"'))
    env.run("noaa")
    times = [t for (t,) in env.query("SELECT time FROM lake.points ORDER BY time")]
    assert times[0] == datetime(2026, 10, 13, 18, 0, 1)


def test_runs_prune_catalogs_past_retention(env, monkeypatch):
    monkeypatch.setattr(catalog, "RETAIN", timedelta(0))
    published = []
    for n in (1, 2, 3):
        env.noaa.put(noaa_key(n), noaa_csv(ROWS, file_uuid=str(n)))
        env.run("noaa")
        published.append(env.store.get(catalog.POINTER)[0].decode())
    catalogs = [o.key for o in env.store.list("catalog/")[0] if o.key.endswith(".ducklake")]
    # The current catalog, and the one the last run started from.
    assert set(catalogs) == set(published[1:])
    assert len(env.active()) == 3


@pytest.mark.parametrize(
    "error, invalid",
    [
        (duckdb.OutOfRangeException, True),
        (duckdb.NotImplementedException, True),
        (duckdb.OutOfMemoryException, False),
        (duckdb.BinderException, False),
    ],
)
def test_only_content_errors_make_a_file_invalid(tmp_path, monkeypatch, error, invalid):
    def fail(*_):
        raise error("boom")

    monkeypatch.setattr(sources, "content_hash", fail)
    with pytest.raises(Invalid if invalid else error):
        parse("noaa", noaa_key(1), noaa_csv(ROWS), tmp_path)


def test_a_key_list_whose_folders_cant_all_be_listed_alerts(env, monkeypatch):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, file_uuid="1"))
    listing = env.noaa.list
    monkeypatch.setattr(env.noaa, "list", lambda prefix="": (listing(prefix)[0], False))
    with open_store(env.store) as con:
        assert Ingest(con, "noaa", env.noaa, keys={noaa_key(1)}).run().alert


def test_a_key_list_that_finds_nothing_alerts(env):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, file_uuid="1"))
    with open_store(env.store) as con:
        # Keys without NOAA's prefix: listed nowhere, so all missing.
        run = Ingest(con, "noaa", env.noaa, keys={noaa_key(1).removeprefix("csb/csv/")}).run()
    assert run.alert and run.counts["missing"] == 1
    with open_store(env.store) as con:
        assert Ingest(con, "noaa", env.noaa, keys=set()).run().alert  # an empty key file


def test_a_key_list_needs_a_source(tmp_path):
    from grid.cli import main

    keys = tmp_path / "keys.txt"
    keys.write_text(noaa_key(1))
    for picked in ([], ["--source", "noaa", "--source", "openwaters"]):
        with pytest.raises(SystemExit):
            main(["--store", str(tmp_path / "store"), "ingest", *picked, "--keys", str(keys)])


def test_a_key_list_ingests_only_its_keys_and_withdraws_nothing(env):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, file_uuid="1"))
    env.noaa.put(noaa_key(2), noaa_csv(ROWS, unique_id="B", file_uuid="2"))
    env.run("noaa")
    env.noaa.delete(noaa_key(1))  # gone from the bucket, but not in this run's keys
    env.noaa.put(noaa_key(3), noaa_csv(ROWS, unique_id="C", file_uuid="3"))
    env.noaa.put(noaa_key(4), noaa_csv(ROWS, unique_id="D", file_uuid="4"))
    keys = {noaa_key(3), noaa_key(5)}  # 5 is in the index but not the bucket
    listed = []
    list_ = env.noaa.list
    env.noaa.list = lambda prefix="": listed.append(prefix) or list_(prefix)
    with open_store(env.store) as con:
        run = Ingest(con, "noaa", env.noaa, keys=keys).run()
    # Only the keys' folder is listed, not the whole bucket.
    assert listed == ["csb/csv/2026/10/14/"]
    assert not run.alert
    assert run.counts["missing"] == 1 and run.counts["new"] == 1
    assert run.counts["bytes"] == len(noaa_csv(ROWS, unique_id="C", file_uuid="3"))
    files = env.files()
    assert files[noaa_key(1)][0] == "active"  # not withdrawn
    assert noaa_key(4) not in files  # not in the keys
    assert files[noaa_key(3)][0] == "active"


def test_a_run_whose_lease_ran_low_publishes_nothing(tmp_path, monkeypatch):
    # Renewal stalls without noticing (a hung request): the lock isn't lost yet, but
    # another run could take it over before a publish that started now finished.
    store = LocalObjects(tmp_path)
    with open_store(store):
        pass
    first = store.get(POINTER)[0]
    monkeypatch.setattr(Lock, "_renew", lambda self: self._stop.wait())
    with pytest.raises(Locked), open_store(store, ttl=timedelta(seconds=0.4)) as con:
        con.execute("INSERT INTO lake.withdrawal_holds VALUES ('noaa', 'k', 1, false)")
        time.sleep(0.25)
    assert store.get(POINTER)[0] == first
