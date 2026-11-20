import fcntl
import json
import os

import numpy as np
import pytest
import rasterio

from grid import depth, publish, surface, tiles
from grid.objects import LocalObjects


def write_surface(path, values):
    rows, cols = values.shape
    with surface.open_sparse(path, -76, 36, (rows, cols)) as dst:
        bands = np.full((5, rows, cols), surface.NODATA, np.float32)
        bands[0] = values
        dst.write(bands)


def run_dir(tmp_path):
    (tmp_path / "surface").mkdir(parents=True)
    return tmp_path


def read_depth(run):
    with rasterio.open(run / "depth.tif") as src:
        return src.read(1), src.nodata, src.tags(), src.descriptions


def test_copies_round_to_the_centimetre_and_keep_no_data(tmp_path):
    run = run_dir(tmp_path)
    values = np.full((64, 64), surface.NODATA, np.float32)
    values[10:20, 10:20] = 7.0912
    values[30, 30] = 199.336
    write_surface(run / "surface" / "45464.tif", values)
    (run / "credits.txt").write_text("Crowd Depth\n")
    done = depth.build(run)
    assert done == {"copied": 1, "removed": 0, "tiles": 1, "merged": True, "failed": []}
    got, nodata, tags, descriptions = read_depth(run)
    assert nodata == surface.NODATA
    assert (got == surface.NODATA).sum() == 64 * 64 - 101
    np.testing.assert_array_equal(got[10:20, 10:20], np.float32(7.09))
    assert got[30, 30] == np.float32(199.34)
    assert tags["ATTRIBUTION"] == "Crowd Depth" and tags["LICENSE"] == "CC-BY-4.0"
    assert descriptions == ("depth",)


def test_build_follows_surfaces(tmp_path):
    run = run_dir(tmp_path)
    path = run / "surface" / "45464.tif"
    values = np.full((64, 64), surface.NODATA, np.float32)
    values[10:20, 10:20] = 8.0
    write_surface(path, values)
    (run / "depth").mkdir()
    (run / "depth" / "45464.tif.tmp").write_text("killed")
    (run / "depth.tif.tmp").write_text("killed")
    assert depth.build(run)["copied"] == 1
    assert not list(run.rglob("*.tmp"))
    # Nothing changed: nothing copied or merged again. A rewritten surface is.
    assert depth.build(run) == {
        "copied": 0,
        "removed": 0,
        "tiles": 1,
        "merged": False,
        "failed": [],
    }
    copy = run / "depth" / "45464.tif"
    os.utime(path, (copy.stat().st_mtime + 10,) * 2)
    assert depth.build(run)["copied"] == 1
    # A surface synced in with an older time than its copy's is copied too.
    os.utime(path, (copy.stat().st_mtime - 3600,) * 2)
    assert depth.build(run)["copied"] == 1
    # Other code copied it: copied again.
    record = run / "depth" / "copied.json"
    record.write_text(
        json.dumps({k: "older" + v for k, v in json.loads(record.read_text()).items()})
    )
    assert depth.build(run)["copied"] == 1
    path.unlink()
    assert depth.build(run) == {"copied": 0, "removed": 1, "tiles": 0, "merged": True, "failed": []}
    assert not (run / "depth.tif").exists()


def test_a_merge_cut_short_is_merged_next_time(tmp_path):
    run = run_dir(tmp_path)
    write_surface(run / "surface" / "45464.tif", np.full((64, 64), 8.0, np.float32))
    depth.build(run)
    # Killed after the copies were recorded, before the merge finished.
    (run / "depth" / "merged.txt").unlink()
    assert depth.build(run) == {"copied": 0, "removed": 0, "tiles": 1, "merged": True, "failed": []}


def test_build_refuses_without_surfaces_or_lock(tmp_path):
    with pytest.raises(FileNotFoundError):
        depth.build(tmp_path)
    run = run_dir(tmp_path)
    with open(run / ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(RuntimeError, match="using"):
            depth.build(run)


def published(run, target, *tiles_):
    """Mark `run` as the `grid tiles` run last published to `target`, with `tiles_` live."""
    (run / "tiles.txt").write_text("".join(f"{t}\t10\n" for t in tiles_))
    (run / "fp").mkdir(exist_ok=True)
    for t in tiles_:
        (run / "fp" / f"{t}.txt").write_text(f"fp{t}")
    manifest = {"tiles": {str(t): {"fingerprint": f"fp{t}"} for t in tiles_}}
    target.put(publish.MANIFEST, json.dumps(manifest).encode())


def test_one_bad_tile_spares_the_rest_and_publishes_nothing(tmp_path):
    run = run_dir(tmp_path / "run")
    write_surface(run / "surface" / "45464.tif", np.full((64, 64), 8.0, np.float32))
    (run / "surface" / "45465.tif").write_bytes(b"not a tiff")
    target = LocalObjects(tmp_path / "published")
    published(run, target, 45464, 45465)
    with pytest.raises(RuntimeError, match="45465"):
        depth.build(run, objects=target)
    assert (run / "depth" / "45464.tif").exists()
    assert (read_depth(run)[0] == 8.0).all()
    assert not (tmp_path / "published" / publish.DEPTH).exists()
    # The bad tile is tried again; the copied one isn't.
    copied = (run / "depth" / "45464.tif").stat().st_mtime_ns
    with pytest.raises(RuntimeError, match="45465"):
        depth.build(run)
    assert (run / "depth" / "45464.tif").stat().st_mtime_ns == copied


def test_tiles_of_different_widths_merge(tmp_path):
    # Columns widen with latitude: tiles further north have fewer.
    run = run_dir(tmp_path)
    with surface.open_sparse(run / "surface" / "1.tif", -76, 36, (64, 64)) as dst:
        dst.write(np.full((5, 64, 64), 5.0, np.float32))
    with surface.open_sparse(run / "surface" / "2.tif", -76, 37, (64, 40)) as dst:
        dst.write(np.full((5, 64, 40), 6.0, np.float32))
    assert depth.build(run)["tiles"] == 2
    with rasterio.open(run / "depth.tif") as src:
        assert set(np.unique(src.read(1))) == {5.0, 6.0}
        assert src.transform.a == 1 / 64


def test_a_credit_change_merges_again(tmp_path):
    run = run_dir(tmp_path)
    write_surface(run / "surface" / "45464.tif", np.full((64, 64), 8.0, np.float32))
    (run / "credits.txt").write_text("Crowd Depth\n")
    depth.build(run)
    (run / "credits.txt").write_text("Crowd Depth; a new station\n")
    assert depth.build(run)["merged"]
    assert read_depth(run)[2]["ATTRIBUTION"] == "Crowd Depth; a new station"


def test_publish_uploads_only_what_changed_and_takes_down_when_asked(tmp_path):
    run = run_dir(tmp_path / "run")
    path = run / "surface" / "45464.tif"
    write_surface(path, np.full((64, 64), 8.0, np.float32))
    target = LocalObjects(tmp_path / "published")
    published(run, target, 45464)
    out = tmp_path / "published" / publish.DEPTH
    assert depth.build(run, objects=target)["published"] == "uploaded"
    assert out.read_bytes() == (run / "depth.tif").read_bytes()
    assert depth.build(run, objects=target)["published"] == "kept"
    # Replaced there by someone else: put back.
    out.write_bytes(b"other")
    assert depth.build(run, objects=target)["published"] == "uploaded"
    write_surface(path, np.full((64, 64), 9.0, np.float32))
    assert depth.build(run, objects=target)["published"] == "uploaded"
    assert out.read_bytes() == (run / "depth.tif").read_bytes()
    # Every tile withdrawn, as `grid tiles` leaves it: taken down only when asked.
    tiles.forget(run, 45464)
    published(run, target)
    with pytest.raises(RuntimeError, match="--take-down"):
        depth.build(run, objects=target)
    assert out.exists()
    assert depth.build(run, objects=target, take_down=True)["published"] == "deleted"
    assert not out.exists()
    assert depth.build(run, objects=target, take_down=True)["published"] == "none"


def test_take_down_refuses_surfaces_without_a_tile_list(tmp_path):
    run = run_dir(tmp_path / "run")
    write_surface(run / "surface" / "45464.tif", np.full((64, 64), 8.0, np.float32))
    target = LocalObjects(tmp_path / "published")
    with pytest.raises(RuntimeError, match="no tiles.txt"):
        depth.build(run, objects=target, take_down=True)
    assert not (tmp_path / "published" / publish.DEPTH).exists()


def test_publish_refuses_a_run_other_than_the_published_one(tmp_path):
    run = run_dir(tmp_path / "run")
    write_surface(run / "surface" / "45464.tif", np.full((64, 64), 8.0, np.float32))
    target = LocalObjects(tmp_path / "published")
    (run / "tiles.txt").write_text("45464\t10\n")
    (run / "fp").mkdir()
    (run / "fp" / "45464.txt").write_text("fp45464")
    # Never published there.
    with pytest.raises(RuntimeError, match="last published"):
        depth.build(run, objects=target)
    # Published there from other inputs, by a later run or before a failed one.
    target.put(
        publish.MANIFEST, json.dumps({"tiles": {"45464": {"fingerprint": "other"}}}).encode()
    )
    with pytest.raises(RuntimeError, match="last published"):
        depth.build(run, objects=target)
    # Or with another tile.
    published(run, target, 45464, 45465)
    (run / "tiles.txt").write_text("45464\t10\n")
    with pytest.raises(RuntimeError, match="last published"):
        depth.build(run, objects=target)
    assert not (tmp_path / "published" / publish.DEPTH).exists()
    published(run, target, 45464)
    assert depth.build(run, objects=target)["published"] == "uploaded"


def test_publish_keeps_the_published_file_when_surfaces_are_cleared(tmp_path):
    run = run_dir(tmp_path / "run")
    path = run / "surface" / "45464.tif"
    write_surface(path, np.full((64, 64), 8.0, np.float32))
    target = LocalObjects(tmp_path / "published")
    published(run, target, 45464)
    depth.build(run, objects=target)
    path.unlink()
    with pytest.raises(RuntimeError, match="no depth.tif"):
        depth.build(run, objects=target)
    assert (tmp_path / "published" / publish.DEPTH).exists()


def test_publish_refuses_another_stores_place(tmp_path):
    run = run_dir(tmp_path / "run")
    write_surface(run / "surface" / "45464.tif", np.full((64, 64), 8.0, np.float32))
    (run / "store.txt").write_text("s3://staging/lake/\n")
    target = LocalObjects(tmp_path / "published")
    published(run, target, 45464)
    target.put(publish.MANIFEST, json.dumps({"store": "0123456789abcdef"}).encode())
    with pytest.raises(RuntimeError, match="another store"):
        depth.build(run, objects=target)
    assert not (tmp_path / "published" / publish.DEPTH).exists()
