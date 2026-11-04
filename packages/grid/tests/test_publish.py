import contextlib
import json
import subprocess
import sys
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from grid import cli, tiles
from grid.catalog import Lock
from grid.objects import LocalObjects, S3Objects
from grid.publish import ARCHIVE, KINDS, LOCK, MANIFEST, RETIRED_FOR, publish

DAY = datetime(2026, 11, 3, tzinfo=UTC)


def make_run(run, outputs, archive=b"archive 1"):
    """A finished run's directory: {tile: {kind: bytes}}, and its archive."""
    run.mkdir(exist_ok=True)
    (run / "fp").mkdir(exist_ok=True)
    (run / "tiles.txt").write_text("".join(f"{t}\t{100 + t}\n" for t in sorted(outputs)))
    (run / "credits.txt").write_text("NOAA DCDB\n")
    for t, files in outputs.items():
        tiles.fp_path(run, t).write_text(f"fp{t}\n")
        for kind, data in files.items():
            path = run / tiles.TILE_FILES[kind].format(t)
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(data)
    (run / ARCHIVE).write_bytes(archive)


def manifest(out):
    return json.loads(out.get(MANIFEST)[0])


def tile_keys(out):
    return sorted(o.key for o in out.list("tiles/")[0])


def full(n):
    return {"surface": b"tif%d" % n, "cells": b"parquet%d" % n, "areas": b"areas%d" % n}


def test_a_run_publishes_its_archive_and_each_tiles_files_by_content(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    # Tile 2 has no cells, so no surface.
    make_run(run, {1: full(1), 2: {"cells": b"c", "areas": b"a"}})
    done = publish(run, out, now=DAY)
    assert done == {
        "uploaded": 5,
        "bytes": 4 + 8 + 6 + 1 + 1 + 9,
        "kept": 0,
        "archive": "replaced",
        "deleted": 0,
    }
    assert out.get(ARCHIVE)[0] == b"archive 1"
    got = manifest(out)
    assert got["archive"]["size"] == 9
    assert got["license"] == "CC-BY-4.0" and got["attribution"] == "NOAA DCDB"
    one = got["tiles"]["1"]
    assert one["fingerprint"] == "fp1" and one["soundings"] == 101
    assert one["surface"].startswith("tiles/surface/1-") and one["surface"].endswith(".tif")
    assert out.get(one["cells"])[0] == b"parquet1"
    assert "surface" not in got["tiles"]["2"]
    assert got["tiles"]["2"]["cells"].startswith("tiles/cells/2-")
    # The lock is released.
    assert json.loads(out.get(LOCK)[0])["released"]


def test_a_republish_uploads_only_what_changed(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1), 2: full(2)})
    publish(run, out, now=DAY)
    first = manifest(out)

    # Nothing changed: only the manifest is written.
    again = publish(run, out, now=DAY + timedelta(hours=1))
    assert again["uploaded"] == again["bytes"] == 0 and again["archive"] == "kept"
    assert manifest(out)["tiles"] == first["tiles"]

    # Tile 2's surface and the archive changed.
    make_run(run, {1: full(1), 2: full(2) | {"surface": b"tif2 again"}}, archive=b"archive 2")
    moved = publish(run, out, now=DAY + timedelta(hours=2))
    assert moved["uploaded"] == 1 and moved["archive"] == "replaced"
    got = manifest(out)
    old, new = first["tiles"]["2"]["surface"], got["tiles"]["2"]["surface"]
    assert old != new and out.get(new)[0] == b"tif2 again"
    # A reader still on the last manifest can read the file it names.
    assert out.get(old)[0] == b"tif2"
    assert got["retired"] == {old: (DAY + timedelta(hours=2)).isoformat()}
    assert out.get(ARCHIVE)[0] == b"archive 2"

    # Past RETIRED_FOR the old surface goes.
    later = publish(run, out, now=DAY + timedelta(hours=2) + RETIRED_FOR + timedelta(seconds=1))
    assert later["deleted"] == 1 and out.get(old) is None
    assert manifest(out)["retired"] == {}


def test_a_gone_tiles_files_go_at_once(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1), 2: full(2)})
    publish(run, out, now=DAY)
    gone = manifest(out)["tiles"]["2"]

    tiles.forget(run, 2)
    make_run(run, {1: full(1)})
    assert publish(run, out, now=DAY + timedelta(hours=1))["deleted"] == 3
    got = manifest(out)
    assert "2" not in got["tiles"] and got["retired"] == {}
    assert all(out.get(k) is None for k in (gone["surface"], gone["cells"], gone["areas"]))

    # Back: uploaded again.
    make_run(run, {1: full(1), 2: full(2)})
    assert publish(run, out, now=DAY + timedelta(hours=2))["uploaded"] == 3
    assert manifest(out)["tiles"]["2"] == gone


def test_a_gone_tiles_retired_files_go_at_once_too(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1), 2: full(2)})
    publish(run, out, now=DAY)
    make_run(run, {1: full(1), 2: full(2) | {"surface": b"tif2 again"}})
    publish(run, out, now=DAY + timedelta(hours=1))
    assert len(manifest(out)["retired"]) == 1
    tiles.forget(run, 2)
    make_run(run, {1: full(1)})
    publish(run, out, now=DAY + timedelta(hours=2))
    assert manifest(out)["retired"] == {}
    assert tile_keys(out) == sorted(manifest(out)["tiles"]["1"][k] for k in KINDS)


def test_a_file_the_manifest_names_but_the_bucket_lost_goes_up_again(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    publish(run, out, now=DAY)
    lost = manifest(out)["tiles"]["1"]["cells"]
    out.delete(lost)
    assert publish(run, out, now=DAY + timedelta(hours=1))["uploaded"] == 1
    assert out.get(lost)[0] == b"parquet1"


def test_a_target_holding_another_stores_tiles_is_refused(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    (run / "store.txt").write_text("s3://prod/lake/ at https://account.example\n")
    publish(run, out, now=DAY)
    # Named by a hash: the manifest is public, the store's endpoint isn't.
    assert "prod" not in out.get(MANIFEST)[0].decode()
    (run / "store.txt").write_text("s3://staging/lake/ at https://account.example\n")
    with pytest.raises(RuntimeError, match="holds another store's tiles"):
        publish(run, out, now=DAY + timedelta(hours=1))
    assert manifest(out)["tiles"]["1"]


def test_a_retired_file_that_comes_back_is_not_uploaded(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    publish(run, out, now=DAY)
    make_run(run, {1: full(1) | {"cells": b"other"}})
    publish(run, out, now=DAY + timedelta(hours=1))
    make_run(run, {1: full(1)})
    back = publish(run, out, now=DAY + timedelta(hours=2))
    assert back["uploaded"] == back["deleted"] == 0
    # The cells it replaced are retired in turn.
    retired = manifest(out)["retired"]
    assert len(retired) == 1 and out.get(next(iter(retired)))[0] == b"other"
    assert len(tile_keys(out)) == 4


def test_files_no_manifest_names_are_swept(tmp_path):
    """What a publish stopped before its manifest, or a failed delete, left behind."""
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    out.put("tiles/cells/1-0123456789abcdef.parquet", b"left behind")
    assert publish(run, out, now=DAY)["deleted"] == 1
    assert tile_keys(out) == sorted(manifest(out)["tiles"]["1"][k] for k in KINDS)


def test_files_a_publish_didnt_write_are_left_alone(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    out.put("tiles/seascape/0/0/0.png", b"someone else's")
    publish(run, out, now=DAY)
    assert out.get("tiles/seascape/0/0/0.png")[0] == b"someone else's"


def test_the_stored_archive_is_replaced_when_it_isnt_the_manifests(tmp_path):
    """A publish stopped after replacing the archive, before its manifest: the next one
    puts its own back, though its bytes are what the manifest names."""
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    publish(run, out, now=DAY)
    out.put(ARCHIVE, b"another run's archive")
    assert publish(run, out, now=DAY + timedelta(hours=1))["archive"] == "replaced"
    assert out.get(ARCHIVE)[0] == b"archive 1"


def test_a_store_with_every_tile_withdrawn_takes_everything_down(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    publish(run, out, now=DAY)
    tiles.forget(run, 1)
    make_run(run, {})
    (run / ARCHIVE).unlink()
    done = publish(run, out, now=DAY + timedelta(hours=1))
    assert done["archive"] == "deleted" and done["deleted"] == 3
    assert out.get(ARCHIVE) is None and tile_keys(out) == []
    assert manifest(out)["tiles"] == {} and manifest(out)["archive"] is None


def test_one_publisher_at_a_time(tmp_path):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    other = Lock(out, key=LOCK)
    other.acquire()
    try:
        with pytest.raises(RuntimeError, match="another run is publishing"):
            publish(run, out, now=DAY)
    finally:
        other.release()
    assert out.get(MANIFEST) is None and out.get(ARCHIVE) is None


def test_a_local_targets_lock_holds_across_processes(tmp_path):
    out = LocalObjects(tmp_path / "out")
    out.put("x", b"")
    # Another process in the middle of a conditional put holds the store's put lock.
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import fcntl, sys; f = open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX);"
                " print(flush=True); sys.stdin.read()"
            ),
            str(tmp_path / "out" / ".put.lock"),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    holder.stdout.readline()
    taking = threading.Thread(target=Lock(out, key=LOCK).acquire)
    taking.start()
    taking.join(0.3)
    assert taking.is_alive() and out.get(LOCK) is None
    holder.communicate(b"")
    taking.join(5)
    assert out.get(LOCK) is not None


@pytest.mark.parametrize("failing", ["tiles/", ARCHIVE])
def test_an_incomplete_listing_publishes_nothing(tmp_path, monkeypatch, failing):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    listing = out.list
    monkeypatch.setattr(out, "list", lambda prefix="": (listing(prefix)[0], prefix != failing))
    with pytest.raises(RuntimeError, match="couldn't list"):
        publish(run, out, now=DAY)
    # Tile files uploaded before the archive's listing failed are named by nothing, and
    # the next publish sweeps them.
    assert out.get(MANIFEST) is None and out.get(ARCHIVE) is None


def test_a_manifest_changed_meanwhile_is_not_overwritten(tmp_path, monkeypatch):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    publish(run, out, now=DAY)
    upload = out.upload

    def meanwhile(key, path, *args, **kwargs):
        upload(key, path, *args, **kwargs)
        out.put(MANIFEST, b"{}")

    monkeypatch.setattr(out, "upload", meanwhile)
    make_run(run, {1: full(1)}, archive=b"archive 2")
    with pytest.raises(RuntimeError, match="changed while publishing"):
        publish(run, out, now=DAY + timedelta(days=1))
    assert out.get(MANIFEST)[0] == b"{}"


@pytest.mark.parametrize("missing", [ARCHIVE, "cells", "areas"])
def test_an_unfinished_run_publishes_nothing(tmp_path, missing):
    run, out = tmp_path / "run", LocalObjects(tmp_path / "out")
    make_run(run, {1: full(1)})
    (run / tiles.TILE_FILES.get(missing, missing).format(1)).unlink()
    with pytest.raises(RuntimeError, match="didn't finish"):
        publish(run, out)
    assert out.get(MANIFEST) is None and tile_keys(out) == []


@pytest.mark.parametrize(
    "code, dry_run, published", [(0, False, True), (1, False, False), (0, True, False)]
)
def test_a_run_publishes_only_when_every_job_succeeded(
    tmp_path, monkeypatch, code, dry_run, published
):
    calls = []
    monkeypatch.setattr(tiles, "prepare", lambda store, run: {"tiles": 1})
    monkeypatch.setattr(tiles, "code", lambda: "code")
    monkeypatch.setattr(tiles, "warm_worker", lambda: contextlib.nullcontext(("sock", 0)))
    monkeypatch.setattr(
        tiles.subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, code)
    )
    monkeypatch.setattr("grid.publish.publish", lambda run, to: calls.append(to) or {})
    out = LocalObjects(tmp_path / "out")
    assert tiles.build(None, tmp_path / "run", 1, 1024, dry_run, publish_to=out) == code
    assert calls == ([out] if published else [])


def test_a_store_with_nothing_left_unpublishes_only_when_told_to(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(tiles, "prepare", lambda store, run: {"tiles": 0})
    monkeypatch.setattr("grid.publish.publish", lambda run, to: calls.append(to) or {})
    out = LocalObjects(tmp_path / "out")
    # A catalog read empty by mistake would take everything down too.
    with pytest.raises(RuntimeError, match="--take-down unpublishes"):
        tiles.build(None, tmp_path / "run", publish_to=out)
    assert calls == []
    assert tiles.build(None, tmp_path / "run", publish_to=out, take_down=True) == 0
    assert calls == [out]


@pytest.mark.parametrize(
    "publish_to, clash",
    [
        ("pub", False),
        ("store", True),
        ("store/pub", True),
        ("run/pub", True),
        (".", True),
    ],
)
def test_a_publish_target_stands_apart_from_the_store_and_run(
    tmp_path, monkeypatch, publish_to, clash
):
    monkeypatch.chdir(tmp_path)
    assert cli.clashes(publish_to, "store", Path("run")) == clash


@pytest.mark.parametrize(
    "publish_to, store, clash",
    [
        ("s3://b/pub/", "s3://b/store/", False),
        ("s3://b/", "s3://b/store/", True),
        ("s3://b/store/pub/", "s3://b/store/", True),
        ("s3://b/st/", "s3://b/store/", False),
        ("run/pub", "s3://b/store/", True),
        ("pub", "s3://b/store/", False),
    ],
)
def test_a_bucket_publish_target_stands_apart_from_the_store(
    tmp_path, monkeypatch, publish_to, store, clash
):
    monkeypatch.chdir(tmp_path)
    assert cli.clashes(publish_to, store, Path("run")) == clash


def test_an_upload_to_r2_names_its_type_and_caching_and_goes_up_in_parts(tmp_path):
    seen = {}

    class Client:
        def upload_file(self, path, bucket, key, ExtraArgs, Config):
            seen.update(path=path, bucket=bucket, key=key, args=ExtraArgs, config=Config)

    S3Objects("b", "crowd-depth", Client()).upload(
        "overlay.pmtiles", tmp_path / "a", "x/y", "no-cache"
    )
    assert seen["key"] == "crowd-depth/overlay.pmtiles"
    assert seen["args"] == {"ContentType": "x/y", "CacheControl": "no-cache"}
    assert seen["config"].multipart_threshold == 64 * 2**20


def test_a_put_to_r2_names_its_type_and_caching():
    seen = {}

    class Client:
        def put_object(self, **args):
            seen.update(args)
            return {"ETag": '"e"'}

    S3Objects("b", "crowd-depth", Client()).put(
        "manifest.json", b"{}", cache_control="no-cache", content_type="application/json"
    )
    assert seen["Key"] == "crowd-depth/manifest.json"
    assert seen["ContentType"] == "application/json"
    assert seen["CacheControl"] == "no-cache"
    # The lock and catalog name no type, and boto3 refuses a None.
    seen.clear()
    S3Objects("b", "crowd-depth", Client()).put("lock", b"{}")
    assert "ContentType" not in seen and "CacheControl" not in seen


def test_a_publish_serves_the_manifest_as_json_and_names_every_files_type(tmp_path):
    headers = {}

    class Recording(LocalObjects):
        def upload(self, key, path, content_type, cache_control, threads=True):
            headers[key] = (content_type, cache_control)
            super().upload(key, path, content_type, cache_control, threads)

        def put(self, key, data, cache_control=None, content_type=None, **kw):
            headers[key] = (content_type, cache_control)
            return super().put(key, data, **kw)

    run = tmp_path / "run"
    make_run(run, {1: full(1)})
    publish(run, Recording(tmp_path / "out"), now=DAY)
    assert headers[MANIFEST] == ("application/json", "no-cache")
    assert headers[ARCHIVE] == ("application/vnd.pmtiles", "no-cache")
    tile = {k.split("/")[1]: v for k, v in headers.items() if k.startswith("tiles/")}
    assert tile == {
        "surface": ("image/tiff", "public, max-age=3600"),
        "cells": ("application/vnd.apache.parquet", "public, max-age=3600"),
        "areas": ("application/x-ndjson", "public, max-age=3600"),
    }
