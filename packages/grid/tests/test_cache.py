import contextlib
import hashlib
import io
import os
import sqlite3
import urllib.request
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pytest
from test_grid import put
from test_ingest import ROWS, env, geojson, ow_key  # noqa: F401  (env, a fixture)

from grid import cache, reference, tide
from grid.catalog import open_store
from grid.ingest import Ingest
from grid.objects import LocalObjects

RASTER = b"a raster's bytes" * 1000
SHA = hashlib.sha256(RASTER).hexdigest()
LINK = "https://bucket/BlueTopo/T1/BlueTopo_T1_20260101.tiff"


def scheme(sha=SHA):
    """A tile scheme listing one raster, as BlueTopo's GeoPackage does."""
    path = cache.root().parent / f"scheme-{sha[:8]}.gpkg"
    with contextlib.closing(sqlite3.connect(path)) as db:
        db.execute("CREATE TABLE gpkg_contents (table_name TEXT)")
        db.execute("INSERT INTO gpkg_contents VALUES ('t')")
        db.execute(
            'CREATE TABLE t (fid INTEGER PRIMARY KEY, "GeoTIFF_Link" TEXT,'
            ' "GeoTIFF_SHA256_Checksum" TEXT)'
        )
        db.execute('CREATE VIRTUAL TABLE "rtree_t_geom" USING rtree(id, minx, maxx, miny, maxy)')
        db.execute("INSERT INTO t VALUES (1, ?, ?)", [LINK, sha])
        db.execute('INSERT INTO "rtree_t_geom" VALUES (1, 0, 1, 0, 1)')
        db.commit()
    return path.read_bytes()


class Response(io.BytesIO):
    def __init__(self, body, length=None):
        super().__init__(body)
        self.headers = {"Content-Length": str(len(body) if length is None else length)}


def serve(monkeypatch, files, cut=()):
    """urlopen answering from `files`, by URL, the bodies of those in `cut` short of the
    length they give; anything else is no network."""
    asked = []

    def urlopen(url, timeout=None):
        asked.append(url)
        if url not in files:
            raise OSError("no network in this test")
        body = files[url]
        return Response(body[:-10] if url in cut else body, len(body))

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return asked


def bucket_files(gpkg, name="BlueTopo_Tile_Scheme_20260101_000000.gpkg"):
    bucket, prefix, *_ = reference.CATALOGS["bluetopo"]
    key = f"{prefix.rsplit('/', 1)[0]}/{name}"
    return {
        f"{bucket}/?list-type=2&prefix={prefix}": f"<Key>{key}</Key>".encode(),
        f"{bucket}/{key}": gpkg,
        LINK: RASTER,
    }


def test_a_second_run_reads_cached_rasters_with_no_network(monkeypatch):
    serve(monkeypatch, bucket_files(scheme()))
    [first], _ = reference.rasters("bluetopo", (0, 0, 1, 1), {})
    assert first.startswith(str(cache.root())) and Path(first).read_bytes() == RASTER
    # A new store, and NOAA's bucket out of reach: the cached tile scheme and raster serve.
    asked = serve(monkeypatch, {})
    catalogs = {}
    assert reference.rasters("bluetopo", (0, 0, 1, 1), catalogs) == ([first], [])
    assert asked == [next(iter(bucket_files(b"")))]  # only the listing was tried
    # A newer scheme may cover more, so nothing is recorded uncovered from this one.
    assert catalogs["bluetopo"][-1] is True


def test_a_cache_it_cant_write_to_still_calibrates(monkeypatch, tmp_path):
    serve(monkeypatch, bucket_files(scheme()))
    # Under a file, so even root (as in CI's container) can't create it.
    (tmp_path / "file").touch()
    monkeypatch.setenv("GRID_CACHE_DIR", str(tmp_path / "file" / "cache"))
    catalogs = {}
    paths, _ = reference.rasters("bluetopo", (0, 0, 1, 1), catalogs)
    # The scheme from the run's own directory; the raster, uncached, read remotely.
    assert catalogs["bluetopo"][-1] is False and paths == [f"/vsicurl/{LINK}"]


def test_a_cut_off_tile_scheme_is_never_cached(monkeypatch):
    files = bucket_files(scheme())
    serve(monkeypatch, files, cut=[url for url in files if url.endswith(".gpkg")])
    with pytest.raises(OSError, match="bytes of"):
        reference.catalog("bluetopo")
    assert reference.cached_catalogs("bluetopo") == []


def test_a_new_release_is_a_new_entry_and_prune_drops_the_old(monkeypatch):
    serve(monkeypatch, bucket_files(scheme()))
    [old], _ = reference.rasters("bluetopo", (0, 0, 1, 1), {})
    new_raster = RASTER + b"revised"
    files = bucket_files(
        scheme(hashlib.sha256(new_raster).hexdigest()), "BlueTopo_Tile_Scheme_20260201_000000.gpkg"
    )
    serve(monkeypatch, files | {LINK: new_raster})
    [new], _ = reference.rasters("bluetopo", (0, 0, 1, 1), {})
    assert new != old and Path(new).read_bytes() == new_raster
    assert Path(old).read_bytes() == RASTER  # never mixed
    reference.prune()
    assert not Path(old).exists() and Path(new).read_bytes() == new_raster
    assert [p.name for p in reference.cached_catalogs("bluetopo")] == [
        "BlueTopo_Tile_Scheme_20260201_000000.gpkg"
    ]


def test_a_scheme_without_checksums_prunes_nothing(monkeypatch):
    serve(monkeypatch, bucket_files(scheme()))
    [cached], _ = reference.rasters("bluetopo", (0, 0, 1, 1), {})
    # The column renamed: SQLite reads the quoted name as a string in every row.
    [newest] = reference.cached_catalogs("bluetopo")
    with contextlib.closing(sqlite3.connect(newest)) as db:
        db.execute('ALTER TABLE t RENAME COLUMN "GeoTIFF_SHA256_Checksum" TO sha')
        db.commit()
    reference.prune()
    assert Path(cached).read_bytes() == RASTER


def test_only_rasters_holding_a_pixel_are_downloaded(monkeypatch):
    asked = serve(monkeypatch, bucket_files(scheme()))
    far = (np.array([0.5]), np.array([3.0]))
    assert reference.rasters("bluetopo", (0, 0, 1, 1), {}, *far) == ([], [])
    assert LINK not in asked


def test_a_renamed_checksum_column_reads_remotely(monkeypatch):
    serve(monkeypatch, bucket_files(scheme()))
    reference.catalog("bluetopo")
    [newest] = reference.cached_catalogs("bluetopo")
    with contextlib.closing(sqlite3.connect(newest)) as db:
        db.execute('ALTER TABLE t RENAME COLUMN "GeoTIFF_SHA256_Checksum" TO sha')
        db.commit()
    assert reference.rasters("bluetopo", (0, 0, 1, 1), {})[0] == [f"/vsicurl/{LINK}"]


def test_entries_are_readable_by_every_user():
    entry = cache.path("coops", "e.json")
    cache.write_json(entry, [])
    assert entry.stat().st_mode & 0o777 == 0o644


def test_a_cut_off_raster_download_is_never_an_entry(monkeypatch):
    files = bucket_files(scheme())
    serve(monkeypatch, files, cut=[LINK])
    paths, _ = reference.rasters("bluetopo", (0, 0, 1, 1), {})
    # Read remotely instead, and nothing left in the cache under the checksum.
    assert paths == [f"/vsicurl/{LINK}"]
    assert not any(cache.path("reference", "bluetopo", SHA).glob("*"))
    # The next 1° tile it touches reads it remotely, without downloading it again.
    asked = serve(monkeypatch, files)
    assert reference.rasters("bluetopo", (0, 0, 1, 1), {})[0] == [f"/vsicurl/{LINK}"]
    assert LINK not in asked


def test_a_raster_unlike_its_checksum_is_skipped_not_read(monkeypatch):
    files = bucket_files(scheme())
    serve(monkeypatch, files | {LINK: b"another raster"})
    # Neither cached nor read remotely, unverified: its tiles wait for it.
    assert reference.rasters("bluetopo", (0, 0, 1, 1), {})[0] == [None]
    assert not cache.path("reference", "bluetopo", SHA, LINK.rsplit("/", 1)[-1]).exists()
    asked = serve(monkeypatch, files)
    assert reference.rasters("bluetopo", (0, 0, 1, 1), {})[0] == [None]
    assert LINK not in asked
    # Nor in the next run that day; a day later, NOAA has uploaded the raster it listed.
    monkeypatch.setattr(reference, "uncached", {})
    asked = serve(monkeypatch, files)
    assert reference.rasters("bluetopo", (0, 0, 1, 1), {})[0] == [None]
    assert LINK not in asked
    monkeypatch.setattr(reference, "uncached", {})
    [marker] = cache.path("reference", "bluetopo", SHA).glob("*.mismatch")
    os.utime(marker, (0, 0))
    # A retry cut off isn't read remotely, unchecked.
    serve(monkeypatch, files, cut=[LINK])
    assert reference.rasters("bluetopo", (0, 0, 1, 1), {})[0] == [None]
    monkeypatch.setattr(reference, "uncached", {})
    asked = serve(monkeypatch, files)
    [path], _ = reference.rasters("bluetopo", (0, 0, 1, 1), {})
    assert Path(path).read_bytes() == RASTER
    assert not marker.exists()


def test_a_tile_touching_a_skipped_raster_records_nothing(monkeypatch, tmp_path):
    good = []

    def sample_raster(path, lon, lat, depth, relief, unc, shift_at):
        good.append(path)
        depth[:], relief[:], unc[:] = 5.0, 0.1, 0.5
        return True

    monkeypatch.setattr(reference, "rasters", lambda *a, **k: ([None, "good.tif"], []))
    monkeypatch.setattr(reference, "sample_raster", sample_raster)
    tile = 90 * 360 + 180  # 0° N, 0° E
    with open_store(LocalObjects(tmp_path / "store")) as con:
        con.execute("CREATE TEMP TABLE cal_obs AS SELECT ? AS tile_id, 1 AS py, 1 AS px", [tile])
        # The raster that did verify is read, but nothing is kept: a later run tries again.
        assert reference.sample_tile(con, tile, "bluetopo", {}, None) == (0, 0)
        assert good == ["good.tif"]
        assert con.execute("SELECT count(*) FROM lake.reference_pixels").fetchone()[0] == 0


def test_a_damaged_cached_scheme_gives_way_to_an_older_one(monkeypatch):
    serve(monkeypatch, bucket_files(scheme()))
    reference.catalog("bluetopo")
    [older] = reference.cached_catalogs("bluetopo")
    name = "BlueTopo_Tile_Scheme_20260201_000000.gpkg"
    damaged = older.with_name(name)
    damaged.write_bytes(older.read_bytes()[: older.stat().st_size // 2])
    serve(monkeypatch, bucket_files(b"", name))
    path, *_, stale = reference.catalog("bluetopo")
    assert path == older and stale
    # Removed, so the next run downloads it again.
    assert reference.cached_catalogs("bluetopo") == [older]


def test_a_damaged_newest_scheme_is_downloaded_again(monkeypatch):
    gpkg = scheme()
    files = bucket_files(gpkg)
    serve(monkeypatch, files)
    reference.catalog("bluetopo")
    [cached] = reference.cached_catalogs("bluetopo")
    cached.write_bytes(gpkg[: len(gpkg) // 2])
    path, *_, stale = reference.catalog("bluetopo")
    assert path == cached and not stale and cached.read_bytes() == gpkg


def test_a_scheme_of_another_shape_fails_loudly_and_is_kept(monkeypatch):
    serve(monkeypatch, bucket_files(scheme()))
    reference.catalog("bluetopo")
    [older] = reference.cached_catalogs("bluetopo")
    name = "BlueTopo_Tile_Scheme_20260201_000000.gpkg"
    newer = older.with_name(name)
    newer.write_bytes(older.read_bytes())
    with contextlib.closing(sqlite3.connect(newer)) as db:
        db.execute("INSERT INTO gpkg_contents VALUES ('another')")
        db.commit()
    # Newest, it fails the run: NOAA changed what it publishes.
    serve(monkeypatch, bucket_files(b"", name))
    with pytest.raises(ValueError):
        reference.catalog("bluetopo")
    # Cached but out of reach, it gives way to an older one.
    serve(monkeypatch, {})
    path, *_, stale = reference.catalog("bluetopo")
    assert path == older and stale
    assert reference.cached_catalogs("bluetopo") == [older, newer]


def test_an_interrupted_write_leaves_no_entry():
    entry = cache.path("files", "k", "e")
    with pytest.raises(KeyboardInterrupt), cache.writing(entry) as tmp:
        tmp.write_bytes(b"half a file")
        raise KeyboardInterrupt
    assert not entry.exists() and not list(entry.parent.iterdir())
    assert cache.sizes() == {"files": (0, 0)}


class Offline(LocalObjects):
    def download(self, key, path):
        raise OSError("no network in this test")


def test_a_second_store_ingests_cached_files_with_no_network(env, tmp_path):  # noqa: F811
    put(env, 1, [(0, -78.1, 33.1, 5.0)])
    env.run("noaa")
    with open_store(LocalObjects(tmp_path / "second")) as con:
        Ingest(con, "noaa", Offline(env.noaa.root)).run()
        assert con.execute("SELECT count(*) FROM lake.points").fetchone()[0] == 1


def test_open_waters_uploads_are_never_cached(env):  # noqa: F811
    env.ow.put(ow_key(1), geojson(ROWS))
    env.run("openwaters")
    assert env.active() and cache.sizes().get("files", (0, 0))[0] == 0


def test_a_changed_etag_downloads_again(env, tmp_path):  # noqa: F811
    put(env, 1, [(0, -78.1, 33.1, 5.0)])
    env.run("noaa")
    put(env, 1, [(0, -78.1, 33.1, 5.0), (1, -78.1, 33.1, 6.0)])
    with open_store(LocalObjects(tmp_path / "second")) as con:
        Ingest(con, "noaa", env.noaa).run()
        assert con.execute("SELECT count(*) FROM lake.points").fetchone()[0] == 2
    # The old version's entry is gone with it.
    assert cache.sizes()["files"][0] == 1


def test_a_cap_of_zero_keeps_no_files(env, monkeypatch):  # noqa: F811
    monkeypatch.setenv("GRID_CACHE_FILES_GB", "0")
    put(env, 1, [(0, -78.1, 33.1, 5.0)])
    env.run("noaa")
    assert cache.sizes()["files"][0] == 0


def test_files_past_the_cap_are_trimmed_least_recently_used_first():
    for age, name in enumerate(["newest", "middle", "oldest"]):
        entry = cache.path("files", name, "e")
        cache.write_json(entry, "x" * 98)
        os.utime(entry, (1e9 - age, 1e9 - age))
    assert cache.trim("files", 250) == 200
    assert sorted(p.parent.name for p, _ in cache.entries("files")) == ["middle", "newest"]


def test_a_trim_never_takes_a_file_a_run_is_reading(env, tmp_path):  # noqa: F811
    put(env, 1, [(0, -78.1, 33.1, 5.0)])
    env.run("noaa")
    run = Ingest(None, "noaa", Offline(env.noaa.root))
    run.tmp, run.cached = tmp_path, 0
    [obj] = [o for o in env.noaa.list()[0]]
    path = run.fetch(obj)
    # Another run trims everything while this one has yet to read it.
    cache.trim("files", 0)
    assert path.read_bytes() == (env.noaa.root / obj.key).read_bytes()


def test_an_entry_this_user_cant_read_is_a_miss(env, tmp_path, monkeypatch):  # noqa: F811
    put(env, 1, [(0, -78.1, 33.1, 5.0)])
    env.run("noaa")

    def refuse(src, dest):
        raise PermissionError(13, "another user's entry", str(src))

    monkeypatch.setattr(cache, "share", refuse)
    access = os.access
    # Where the link would succeed but the read fail: macOS, or no protected_hardlinks.
    monkeypatch.setattr(os, "access", lambda p, mode: "files" not in str(p) and access(p, mode))
    run = Ingest(None, "noaa", env.noaa)
    run.tmp, run.cached = tmp_path, 0
    [obj] = [o for o in env.noaa.list()[0]]
    assert run.fetch(obj).read_bytes() == (env.noaa.root / obj.key).read_bytes()


def test_a_download_kept_for_its_owner_alone_is_cached_for_everyone(tmp_path):
    src = tmp_path / "download"
    src.write_bytes(b"x")
    src.chmod(0o600)
    entry = cache.path("files", "k", "e")
    assert cache.publish(src, entry)
    assert entry.stat().st_mode & 0o777 == 0o644


def test_entries_another_user_owns_dont_count_against_the_cap(monkeypatch):
    for age, name in enumerate(["theirs", "newer", "older"]):
        entry = cache.path("files", name, "e")
        cache.write_json(entry, "x" * 98)
        os.utime(entry, (1e9 - age, 1e9 - age))
    access = os.access
    monkeypatch.setattr(os, "access", lambda p, mode: Path(p).name != "theirs" and access(p, mode))
    # Theirs is the newest, so a trim that counted it would remove both of this user's.
    assert cache.trim("files", 150) == 100
    assert sorted(p.parent.name for p, _ in cache.entries("files")) == ["newer", "theirs"]


def test_only_the_caches_own_part_files_are_removed(tmp_path, monkeypatch):
    monkeypatch.setenv("GRID_CACHE_DIR", str(tmp_path / "downloads"))
    entry = cache.path("files", "k", "e")
    with pytest.raises(KeyboardInterrupt), cache.writing(entry) as tmp:
        os.link(tmp, tmp.with_name("left"))  # as a write that died leaves it
        raise KeyboardInterrupt
    own = tmp.with_name("left").rename(tmp)
    theirs = cache.root() / "a browser's download.part"
    theirs.write_bytes(b"")
    assert cache.remove_stale_parts(now=1e12) == 1
    assert theirs.exists() and not own.exists()


def residuals(gauge, month):
    return [(datetime(month.year, month.month, 1, 0, 6 * i), 0.1) for i in range(5)]


def offline(gauge, month):
    raise OSError("no network in this test")


def gauge_rows(path, months, today, fetch):
    with open_store(LocalObjects(path)) as con:
        con.execute(
            "CREATE OR REPLACE TEMP TABLE old_levels AS SELECT * FROM lake.tide_levels LIMIT 0"
        )
        tide.fetch_residuals(con, months, today, fetch)
        return con.execute("SELECT count(*) FROM lake.tide_residuals").fetchone()[0]


def test_a_final_gauge_month_serves_a_second_store_with_no_network(tmp_path):
    month = [("8574680", date(2026, 1, 1))]
    assert gauge_rows(tmp_path / "a", month, date(2026, 6, 1), residuals) == 5
    assert gauge_rows(tmp_path / "b", month, date(2026, 6, 1), offline) == 5


def test_a_gauge_month_with_no_data_is_never_cached(tmp_path):
    month = [("8574680", date(2026, 1, 1))]
    # Empty twice, so final in this store; an outage's answer would look the same.
    for _ in range(2):
        gauge_rows(tmp_path / "a", month, date(2026, 6, 1), lambda g, m: [])
    assert not tide.cached_month(*month[0]).exists()


def test_a_recent_gauge_month_is_fetched_again(tmp_path):
    month = [("8574680", date(2026, 1, 1))]
    # 31 January plus 45 days is 17 March: not final on the 10th.
    assert gauge_rows(tmp_path / "a", month, date(2026, 3, 10), residuals) == 5
    assert gauge_rows(tmp_path / "b", month, date(2026, 3, 10), offline) == 0


@pytest.mark.parametrize(
    "kept",
    [
        {"2026-01-01T00:00:00": 0.1},
        [1, 2],
        [["2026-01-01T00:00:00", "x"]],
        [["2026-01-01T00:00:00", "nan"]],
        [["2026-01-01T00:00:00", 99.0]],
    ],
)
def test_a_cached_gauge_month_of_another_shape_is_fetched_again(tmp_path, kept):
    month = [("8574680", date(2026, 1, 1))]
    cache.write_json(tide.cached_month(*month[0]), kept)
    assert gauge_rows(tmp_path / "a", month, date(2026, 6, 1), residuals) == 5
    # And replaced, for the next store.
    assert gauge_rows(tmp_path / "b", month, date(2026, 6, 1), offline) == 5
