import fcntl
import json
import os

import numpy as np
import pytest
import rasterio

from grid import rainbow, surface


def test_ramp_ends():
    rgb = rainbow.colours(np.array([-2.0, 0.0, rainbow.SHALLOW_M, rainbow.DEEP_M]))
    np.testing.assert_allclose(rgb[0], [0.5, 0, 0])
    np.testing.assert_allclose(rgb[1], [0.5, 0, 0])
    np.testing.assert_allclose(rgb[2], [0, 0, 0.5])
    np.testing.assert_allclose(rgb[3], rainbow.ABYSS_RGB, atol=1e-6)


def test_hillshade_lights_slopes_facing_northwest():
    r, c = np.mgrid[0:5, 0:5].astype(np.float32)
    flat = rainbow.hillshade(np.full((5, 5), 10.0), 5, 5)[2, 2]
    # Rows run south: deeper to the northwest, the seabed rises and faces the light.
    facing_nw = rainbow.hillshade(20 - (r + c), 5, 5)[2, 2]
    facing_se = rainbow.hillshade(r + c, 5, 5)[2, 2]
    assert facing_se < flat < facing_nw
    np.testing.assert_allclose(flat, np.sin(np.radians(45)), rtol=1e-6)


def test_draw_contours_and_transparency():
    depth = np.array([[4.9, 5.1, 5.2, rainbow.DEEP_M + 1]] * 2, np.float32)
    valid = np.array([[True, True, False, True]] * 2)
    image = rainbow.draw(depth, valid, 20.0, 20.0)
    # The 5 m contour falls between the first two pixels.
    assert tuple(image[:3, 0, 0]) == rainbow.CONTOUR_RGB
    assert tuple(image[:3, 0, 1]) != rainbow.CONTOUR_RGB
    # Empty and past DEEP_M: not drawn.
    assert list(image[3, 0]) == [255, 255, 0, 0]


def write_surface(path, depth):
    rows, cols = depth.shape
    with surface.open_sparse(path, -76, 36, (rows, cols)) as dst:
        bands = np.full((5, rows, cols), surface.NODATA, np.float32)
        bands[0] = depth
        dst.write(bands)


def run_dir(tmp_path):
    (tmp_path / "surface").mkdir()
    return tmp_path


def test_strips_match_one_draw(tmp_path):
    # A ridge across strip edges: strips must draw it as one raster would.
    rows, cols = 2 * rainbow.STRIP + 88, 40
    r, c = np.mgrid[0:rows, 0:cols].astype(np.float32)
    depth = 15 + 8 * np.sin(r / 9) + c / 10
    depth[rainbow.STRIP + 5 : rainbow.STRIP + 9, 10:20] = surface.NODATA
    path = tmp_path / "45464.tif"
    write_surface(path, depth)
    rainbow.render_tile(path, tmp_path / "out.tif")
    with rasterio.open(tmp_path / "out.tif") as src:
        got, t = src.read(), src.transform
    lat = t.f + t.e * rows / 2
    dx, dy = t.a * rainbow.M_PER_DEG * np.cos(np.radians(lat)), -t.e * rainbow.M_PER_DEG
    want = rainbow.draw(depth, depth != surface.NODATA, dx, dy)
    np.testing.assert_array_equal(got, want)


def test_render_follows_surfaces(tmp_path):
    run = run_dir(tmp_path)
    path = run / "surface" / "45464.tif"
    depth = np.full((64, 64), surface.NODATA, np.float32)
    depth[10:20, 10:20] = 8.0
    write_surface(path, depth)
    (run / "rainbow").mkdir()
    (run / "rainbow" / "45464.tif.tmp").write_text("killed")
    assert rainbow.render(run) == {"rendered": 1, "removed": 0, "tiles": 1, "failed": []}
    assert not list((run / "rainbow").glob("*.tmp"))
    with rasterio.open(run / "rainbow.vrt") as src:
        alpha = src.read(4)
    assert alpha[10:20, 10:20].all() and alpha.sum() == 100 * 255
    # Nothing changed: nothing drawn again. A rewritten surface is.
    assert rainbow.render(run)["rendered"] == 0
    chart = run / "rainbow" / "45464.tif"
    os.utime(path, (chart.stat().st_mtime + 10,) * 2)
    assert rainbow.render(run)["rendered"] == 1
    # A surface synced in with an older time than its chart's is drawn too.
    os.utime(path, (chart.stat().st_mtime - 3600,) * 2)
    assert rainbow.render(run)["rendered"] == 1
    # Other code drew it: drawn again.
    record = run / "rainbow" / "drawn.json"
    record.write_text(
        json.dumps({k: "older" + v for k, v in json.loads(record.read_text()).items()})
    )
    assert rainbow.render(run)["rendered"] == 1
    path.unlink()
    assert rainbow.render(run) == {"rendered": 0, "removed": 1, "tiles": 0, "failed": []}
    assert not (run / "rainbow.vrt").exists()


def test_render_refuses_without_surfaces_or_lock(tmp_path):
    with pytest.raises(FileNotFoundError):
        rainbow.render(tmp_path)
    run = run_dir(tmp_path)
    with open(run / ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(RuntimeError, match="using"):
            rainbow.render(run)


def test_one_bad_tile_spares_the_rest(tmp_path):
    run = run_dir(tmp_path)
    depth = np.full((64, 64), 8.0, np.float32)
    write_surface(run / "surface" / "45464.tif", depth)
    (run / "surface" / "45465.tif").write_bytes(b"not a tiff")
    with pytest.raises(RuntimeError, match="45465"):
        rainbow.render(run)
    assert (run / "rainbow" / "45464.tif").exists()
    with rasterio.open(run / "rainbow.vrt") as src:
        assert src.read(4).all()
    # The bad tile is tried again; the drawn one isn't.
    drawn = (run / "rainbow" / "45464.tif").stat().st_mtime_ns
    with pytest.raises(RuntimeError, match="45465"):
        rainbow.render(run)
    assert (run / "rainbow" / "45464.tif").stat().st_mtime_ns == drawn
