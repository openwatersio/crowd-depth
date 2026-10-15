import json
import time
from datetime import UTC, datetime, timedelta

import pytest

from grid import catalog, ingest
from grid.catalog import LOCK, POINTER, Lock, Locked, open_store
from grid.ingest import Ingest, confirm_withdrawals
from grid.objects import Conflict, LocalObjects
from grid.sources import Invalid, is_submission, parse, parse_noaa

VESSEL = "b0a6561e-970b-48d2-8a17-5862e6a795bc"
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


def test_content_hash_ignores_file_uuid_and_order():
    a = parse_noaa(noaa_csv(ROWS, file_uuid="one"))
    b = parse_noaa(noaa_csv(list(reversed(ROWS)), file_uuid="two"))
    c = parse_noaa(noaa_csv(ROWS[:2] + [(3, -78.3, 33.3, 5.3)]))
    assert a.content_hash == b.content_hash
    assert a.content_hash != c.content_hash


def test_validity():
    for body in (
        noaa_csv([(1, -78.1, 95.0, 4.8)]),
        b"UNIQUE_ID,LON\nx,1\n",
        noaa_csv([(1, -78.1, 33.0, "nan")]),
        noaa_csv([(1, -78.1, 33.0, 1e39)]),  # overflows float32
        HEADER.encode(),
        b"\xff\xfe",
    ):
        with pytest.raises(Invalid):
            parse("noaa", noaa_key(1), body)
    for body in (b"[]", b"{", geojson([(1, -78.1, 33.0, 1e39)])):
        with pytest.raises(Invalid):
            parse("openwaters", ow_key(1), body)
    # Sentinels are QC's business, not invalid files.
    assert parse_noaa(noaa_csv([(1, -78.1, 33.0, -1e9)])).soundings[0].depth == -1e9


def test_malformed_metadata_is_dropped_not_fatal(env):
    doc = json.loads(geojson(ROWS))
    doc["properties"]["platform"]["sensors"] = [
        "x",
        {"type": "Sounder", "make": 5, "position": [{"x": 1}], "draft": "abc"},
    ]
    env.ow.put(ow_key(1), json.dumps(doc).encode())
    env.ow.put(ow_key(1).replace(".geojson", ".done.json"), b"{truncated")
    env.run("openwaters")
    assert env.files()[ow_key(1)] == ("active", None)
    assert env.query(
        "SELECT sounder, sounder_position, draft, noaa_response FROM lake.submission_meta"
    ) == [(None, None, None, "{truncated")]


def test_keys_with_impossible_dates_are_skipped():
    assert not is_submission("noaa", "csb/csv/2026/13/45/20261345000000000000_a_pointData.csv")
    assert not is_submission("openwaters", ow_key(1).replace("2026/10/14", "2026/02/30"))
    assert is_submission("noaa", noaa_key(1)) and is_submission("openwaters", ow_key(1))


def test_fetch_errors_skip_the_file_until_next_run(env, monkeypatch):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    get = env.noaa.get
    monkeypatch.setattr(env.noaa, "get", lambda key: (_ for _ in ()).throw(OSError("reset")))
    assert env.run("noaa")
    assert env.files() == {}
    monkeypatch.setattr(env.noaa, "get", get)
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


def test_point_ids_are_stable(env, tmp_path):
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    env.run("noaa")
    ids = env.query("SELECT point_id FROM lake.points ORDER BY row")
    other = LocalObjects(tmp_path / "other")
    with open_store(other) as con:
        Ingest(con, "noaa", env.noaa).run()
        assert con.execute("SELECT point_id FROM lake.points ORDER BY row").fetchall() == ids
    assert len(set(ids)) == 3


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
    ids = env.query("SELECT point_id FROM lake.points WHERE unique_id = 'AQM-1' ORDER BY row")
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
    assert (
        env.query("SELECT point_id FROM lake.points WHERE unique_id = 'AQM-1' ORDER BY row") == ids
    )


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
    assert store.get(LOCK) is None


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
        assert store.get(LOCK) is None
    assert store.list("catalog/") == before


def test_pointer_moves_only_from_the_version_the_run_started_from(tmp_path):
    store = LocalObjects(tmp_path)
    with open_store(store):
        pass
    first = store.get(POINTER)[0]
    with pytest.raises(Conflict), open_store(store):
        store.put(POINTER, b"catalog/someone-else.ducklake")
    assert store.get(POINTER)[0] == b"catalog/someone-else.ducklake" != first
    assert store.get(LOCK) is None


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
    assert env.query("SELECT count(DISTINCT point_id) FROM lake.points") == [(6,)]


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
    monkeypatch.setattr(env.noaa, "get", lambda key: (_ for _ in ()).throw(OSError("reset")))
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
    assert store.get(LOCK) is None
