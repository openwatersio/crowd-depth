import json
import math

import numpy as np
import pytest
import rasterio.shutil
from rasterio.windows import Window

from grid import benchmark, cli, surface
from grid.catalog import open_store
from grid.cells import BASE
from grid.objects import LocalObjects

LAT0, LON0 = 33, -78  # k = 1
TILE = (LAT0 + 90) * 360 + LON0 + 180
PARTITION = surface.partition_of(LAT0, LON0)
COLS = math.ceil(BASE / surface.PIXEL_BASE)
PY = 100  # every reference pixel is on this row, px 0 to 100


def lonlat(px):
    return LON0 + (px + 0.5) * 2 / BASE, LAT0 + (PY + 0.5) * 2 / BASE


def write_cog(path, depth, count, lon0=LON0):
    """A tile's COG with only the block holding the reference row written."""
    sparse = path.with_suffix(".sparse.tif")
    r0 = (surface.ROWS - 1 - PY) // surface.BLOCK * surface.BLOCK
    r1 = min(r0 + surface.BLOCK, surface.ROWS)
    block = np.s_[r0:r1, : surface.BLOCK]
    with surface.open_sparse(sparse, lon0, LAT0, depth.shape) as dst:
        dst.write(
            np.stack([depth[block], np.zeros_like(depth[block]), count[block]]),
            window=Window(0, r0, surface.BLOCK, r1 - r0),
        )
    rasterio.shutil.copy(sparse, path, driver="COG", sparse_ok=True)
    sparse.unlink()


@pytest.fixture
def store(tmp_path):
    """References at 10 m along a row, a surface with known errors, and a few soundings."""
    store = LocalObjects(tmp_path / "store")
    refs = [(px, 10.0, 0.0, 0.5, "s102") for px in range(99)]
    refs += [
        (99, 3.0, 0.0, 5.0, "s102"),  # too uncertain to anchor
        (100, 10.0, 0.0, 0.5, "s102"),  # the surface doesn't reach
        (0, 20.0, 0.0, 1.0, "bluetopo"),  # more uncertain than s102's, so not the truth
        (1, None, None, None, "bluetopo"),  # no depth: ignored
    ]
    # Soundings: pixel 0 has a rejected vessel, pixel 1 three vessels, pixel 10 a confirmed shoal.
    points = [(b"a0", "A", 0), (b"b0", "B", 0), (b"a1", "A", 1), (b"b1", "B", 1), (b"c1", "C", 1)]
    points += [(b"s", "A", 10)]
    with open_store(store) as con:
        con.executemany(
            "INSERT INTO lake.reference_pixels VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(TILE, PY, px, d, rel, u, s) for px, d, rel, u, s in refs],
        )
        con.execute("INSERT INTO lake.files (file_id, status) VALUES (1, 'active')")
        con.executemany(
            """INSERT INTO lake.points
              (point_id, file_id, unique_id, lon, lat, depth_raw, tile_id, cell_id)
            VALUES (?, 1, ?, ?, ?, 10, ?, ?)""",
            [(pid, v, *lonlat(px), TILE, PARTITION) for pid, v, px in points],
        )
        con.executemany(
            "INSERT INTO lake.qc_flags VALUES (?, ?, ?, 7, ?)",
            [(b"b0", "reject", "spike", PARTITION), (b"s", "confirmed", "cell_shoal", PARTITION)],
        )
        con.execute(
            """INSERT INTO lake.cells (tile_id, depth, depth_lon, depth_lat, cell_id)
            VALUES (?, 9.0, ?, ?, ?)""",
            [TILE, *lonlat(5), PARTITION],
        )
    depth = np.full((surface.ROWS, COLS), surface.NODATA, dtype=np.float32)
    row = surface.ROWS - 1 - PY
    depth[row - 1 : row + 2, :100] = 10.0
    depth[row, 20:23] = 11.5  # more than 1 m too deep
    depth[row, 30] = 7.5  # more than 2 m too shoal
    depth[row, 99] = 0.5  # under 1 m where the reference is 3 m
    count = np.zeros_like(depth)
    count[row, :50] = 1
    (tmp_path / "surface").mkdir()
    write_cog(tmp_path / "surface" / f"{TILE}.tif", depth, count)
    return store, tmp_path / "surface"


def test_known_errors_give_known_shares(store):
    objects, surface_dir = store
    with open_store(objects, write=False) as con:
        result = benchmark.run(con, surface_dir, qc_version=7, with_cells=True)
    s = result["estimates"]["surface"]
    o = s["overall"]
    assert (o["pixels"], o["covered"]) == (101, 100)
    assert o["bias_m"] == 0
    assert o["too_deep"] == pytest.approx(3 / 100)
    assert o["false_shoal"] == pytest.approx(2 / 100)
    assert o["under_1m_over_2m"] == pytest.approx(1 / 100)
    assert o["sigma_m"] is None  # no sigma band
    c = s["classes"]
    assert c["depth"]["2–5 m"]["pixels"] == 1
    assert c["measured"]["measured"]["pixels"] == 50
    # Pixel 0's rejected vessel doesn't count; pixel 10's shoal is a vessel.
    assert c["vessels"]["1"]["pixels"] == 2
    assert c["vessels"]["2–3"]["pixels"] == 1
    assert c["vessels"]["0"]["pixels"] == 98
    assert c["confirmed_shoal"]["within 1 pixel"]["pixels"] == 3
    assert c["anchor"]["held out"]["pixels"] == 1
    assert c["source"]["s102"]["pixels"] == 101
    # Away from the errors, the surface is flat.
    assert o["roughness_m"] == 0
    cells = result["estimates"]["cells"]["overall"]
    assert (cells["covered"], cells["bias_m"]) == (1, -1)


def test_without_flags_at_the_version_every_sounding_counts(store):
    objects, surface_dir = store
    with open_store(objects) as con:
        # Another tile's flag in the same partition says nothing about this tile's soundings.
        con.execute(
            "INSERT INTO lake.points (point_id, file_id, tile_id, cell_id) VALUES ('o', 1, ?, ?)",
            [TILE + 1, PARTITION],
        )
        con.execute("INSERT INTO lake.qc_flags VALUES ('o', 'reject', 'spike', 99, ?)", [PARTITION])
    with open_store(objects, write=False) as con:
        result = benchmark.run(con, surface_dir, qc_version=99)
    assert result["qc_flags_at_version"] == 0
    assert result["estimates"]["surface"]["classes"]["vessels"]["2–3"]["pixels"] == 2
    assert "No QC flags" in benchmark.markdown(result)


def test_a_surface_off_the_reference_grid_is_refused(store, tmp_path):
    objects, _ = store
    off = tmp_path / "off"
    off.mkdir()
    zeros = np.zeros((surface.ROWS, COLS), np.float32)
    # 0.4 of a pixel east: enough to double a too-deep share.
    write_cog(off / f"{TILE}.tif", zeros, zeros, lon0=LON0 + 0.4 / COLS)
    with open_store(objects, write=False) as con, pytest.raises(ValueError, match="pixel grid"):
        benchmark.run(con, off)


def test_tiles_with_references_but_no_surface_are_reported(store):
    objects, surface_dir = store
    with open_store(objects) as con:
        con.execute(
            "INSERT INTO lake.reference_pixels VALUES (?, 0, 0, 10, 0, 0.5, 's102')", [TILE + 1]
        )
    with open_store(objects, write=False) as con:
        # TILE + 2 has no references, so nothing is missing there.
        result = benchmark.run(con, surface_dir, [TILE, TILE + 1, TILE + 2], qc_version=7)
        assert result["tiles_without_surface"] == [TILE + 1]
        assert result["estimates"]["surface"]["overall"]["pixels"] == 102
        with pytest.raises(ValueError, match="no surface COG"):
            benchmark.run(con, surface_dir, [TILE + 1])


def test_cli_writes_json_and_markdown(store, tmp_path):
    objects, surface_dir = store
    out = tmp_path / "out"
    argv = ["--store", str(objects.root), "benchmark", "--surface", str(surface_dir)]
    assert cli.main([*argv, "--out", str(out), "--tiles", str(TILE), "--qc-version", "7"]) == 0
    assert json.loads((out / "benchmark.json").read_text())["tiles"] == [TILE]
    assert "| overall | 101 |" in (out / "benchmark.md").read_text()


def test_a_reference_on_the_tiles_east_edge_is_its_last_pixel(store):
    objects, surface_dir = store
    with open_store(objects) as con:
        # Calibration numbers a sounding at the tile's east edge one past its last pixel.
        con.execute(
            "INSERT INTO lake.reference_pixels VALUES (?, ?, ?, 10, 0, 0.5, 's102')",
            [TILE, PY, COLS],
        )
    with open_store(objects, write=False) as con:
        result = benchmark.run(con, surface_dir, qc_version=7)
    assert result["estimates"]["surface"]["overall"]["pixels"] == 102
