import json
import subprocess
from datetime import date

import duckdb
import numpy as np
import pytest
import rasterio
import rasterio.shutil
import shapely
import test_grid
from pmtiles.reader import MmapSource, Reader
from test_ingest import env  # noqa: F401  (env is a fixture)

from grid import cells, overlay, surface
from grid.catalog import open_store
from grid.overlay import M_PER_FATHOM, M_PER_FT, depths


def test_depths_match_seascape():
    # Seascape's own checks (pipelines/soundings_run.py): S-4 B-412 bands, always
    # floored toward shoal, with whole feet and fathoms.
    assert depths(3.94)["depth_m"] == 3.9 and depths(9.8)["depth_m"] == 9.8
    assert depths(20.99)["depth_m"] == 20.9
    assert depths(23.49)["depth_m"] == 23 and depths(23.81)["depth_m"] == 23.5
    assert depths(31.85)["depth_m"] == 31 and depths(30.99)["depth_m"] == 30.5
    assert depths(5.0)["depth_m"] == 5.0 and depths(9.8)["depth_ft"] == 32
    assert isinstance(depths(5.0)["depth_m"], int)
    assert depths(6.7056)["depth_ft"] == 22 and depths(6.7056)["depth_fm"] == 3
    assert depths(1.8287)["depth_ft"] == 5
    for d in (0.3, 2.7, 6.7056, 20.9, 25.0, 100.0):
        r = depths(d)
        assert r["depth_m"] <= d + 1e-9
        assert r["depth_ft"] * M_PER_FT <= d + 1e-9
        assert r["depth_fm"] * M_PER_FATHOM <= d + 1e-9


def test_zooms():
    assert overlay.zooms(8) == {"minzoom": 8, "maxzoom": 8}
    assert overlay.zooms(overlay.MAX_ZOOM) == {"minzoom": overlay.MAX_ZOOM}


@pytest.fixture
def lake():
    """The tables SOUNDG reads, in memory: cells and unconfirmed shoals."""
    con = duckdb.connect()
    con.execute("ATTACH ':memory:' AS lake")
    con.execute(
        """CREATE TABLE lake.cells (depth_lon DOUBLE, depth_lat DOUBLE, depth FLOAT, kind VARCHAR,
          tile_id INTEGER, lon_min DOUBLE, lat_min DOUBLE, lon_max DOUBLE, lat_max DOUBLE,
          first DATE, last DATE, count INTEGER, tvu FLOAT);
        CREATE TABLE lake.shoals (lon DOUBLE, lat DOUBLE, depth FLOAT)"""
    )
    return con


def features(con):
    return list(overlay.soundings(con))


def at_zoom(feats, z):
    """Features tippecanoe shows at zoom z."""
    return [
        f for f in feats if f["tippecanoe"]["minzoom"] <= z <= f["tippecanoe"].get("maxzoom", 99)
    ]


def test_a_shoal_survives_every_zoom_at_its_own_position(lake):
    # A 10 m field 5 km across, a sounding every 0.005° (more than a pyramid cell at the
    # finest zoom), and one 3 m shoal between them.
    rows = [(-78 + i * 0.005, 33 + j * 0.005, 10.0, "multi") for i in range(10) for j in range(10)]
    rows.append((-77.9775, 33.0225, 3.0, "single"))
    lake.executemany(
        "INSERT INTO lake.cells (depth_lon, depth_lat, depth, kind) VALUES (?, ?, ?, ?)", rows
    )
    feats = features(lake)
    for z in range(overlay.MIN_ZOOM, overlay.MAX_ZOOM + 2):
        shown = at_zoom(feats, z)
        shoal = [f for f in shown if f["properties"]["depth_m"] == 3]
        assert len(shoal) == 1, z
        assert shoal[0]["geometry"]["coordinates"] == [-77.9775, 33.0225]
    # Each zoom shows one field, densifying inward.
    counts = [len(at_zoom(feats, z)) for z in range(overlay.MIN_ZOOM, overlay.MAX_ZOOM + 1)]
    assert counts == sorted(counts) and counts[0] == 1 and counts[-1] == 101


def test_filled_cells_have_no_sounding_and_deep_water_thins(lake):
    lake.executemany(
        "INSERT INTO lake.cells (depth_lon, depth_lat, depth, kind) VALUES (?, ?, ?, ?)",
        [
            (-78.0, 33.0, 5.0, "filled"),
            (-70.0, 33.0, 250.0, "multi"),
            (-60.0, 33.0, 1500.0, "single"),
        ],
    )
    feats = features(lake)
    assert all(f["properties"]["depth_m"] != 5 for f in feats)
    first = {f["properties"]["depth_m"]: f["tippecanoe"]["minzoom"] for f in feats}
    # One coarser level at 200 m and two at 1000 m: the coarsest level shows them one
    # and two zooms later than a shallow sounding's would be.
    assert min(m for d, m in first.items() if d == 250) == overlay.MIN_ZOOM
    assert len([f for f in feats if f["properties"]["depth_m"] == 250]) == (
        overlay.MAX_ZOOM - overlay.MIN_ZOOM + 1
    )
    finest = {f["properties"]["depth_m"] for f in at_zoom(feats, overlay.MAX_ZOOM)}
    assert finest == {250, 1500}


def test_unconfirmed_shoals_publish_flagged(lake):
    lake.execute(
        "INSERT INTO lake.cells (depth_lon, depth_lat, depth, kind) VALUES (-78.0, 33.0, 10.0, 'single')"
    )
    lake.execute("INSERT INTO lake.shoals VALUES (-77.5, 33.0, 1.5)")
    shown = at_zoom(features(lake), overlay.MAX_ZOOM)
    props = sorted((f["properties"]["depth_m"], f["properties"].get("unconfirmed")) for f in shown)
    assert props == [(1.5, 1), (10, None)]
    shoal = next(f for f in shown if f["properties"].get("unconfirmed"))
    assert shoal["properties"]["QUASOU"] == 9 and shoal["properties"]["TECSOU"] == 1


def test_deep_soundings_show_from_a_coarser_level(lake):
    # Two pairs of soundings in neighboring finest pyramid cells that share a parent: a
    # shallow pair both show at the finest zoom, a 250 m pair only its shoaler one.
    step = 360 / (2**overlay.MAX_ZOOM * overlay.CELLS_PER_TILE)
    lon = -180 + 2 * round(100 / step / 2) * step  # the west edge of an even pyramid cell
    rows = []
    for lat, d in ((33.0, 10.0), (-33.0, 250.0)):
        rows += [(lon + step * 0.5, lat, d, "multi"), (lon + step * 1.5, lat, d + 1, "multi")]
    lake.executemany(
        "INSERT INTO lake.cells (depth_lon, depth_lat, depth, kind) VALUES (?, ?, ?, ?)", rows
    )
    finest = sorted(f["properties"]["depth_m"] for f in at_zoom(features(lake), overlay.MAX_ZOOM))
    assert finest == [10, 11, 250]


def box(x0, y0, x1, y1):
    return shapely.box(x0, y0, x1, y1)


PROPERTIES = overlay.quality(date(2026, 1, 1), date(2026, 3, 1), 10, 2.44)


def by_layer(feats):
    out = {}
    for f in feats:
        out.setdefault(f["tippecanoe"]["layer"], []).append(f)
    return out


def geometry(f):
    return shapely.from_geojson(json.dumps(f["geometry"]))


def band_index(level):
    return overlay.LEVELS.index(level)


def test_contours_are_shared_edges_of_bands():
    # A 2-5 m bank west of 10-20 m water, inside a footprint reaching past both.
    bands = {band_index(2): box(0, 0, 1, 2), band_index(10): box(1, 0, 3, 2)}
    got = by_layer(overlay.tile_areas(([0.5], [1], [3.0]), PROPERTIES, bands, box(0, 0, 3, 2)))
    depare = sorted((f["properties"]["DRVAL1"], f["properties"]["DRVAL2"]) for f in got["DEPARE"])
    assert depare == [(2, 5), (10, 20)]
    # One contour per level crossed (5 and 10 m), each the shared edge only, never the
    # footprint's edge.
    contours = {f["properties"]["VALDCO"]: geometry(f) for f in got["DEPCNT"]}
    assert sorted(contours) == [5, 10]
    assert all(
        line.length == pytest.approx(2) and line.bounds[0] == 1 for line in contours.values()
    )
    [coverage] = got["M_QUAL"]
    props = coverage["properties"]
    assert props["CATZOC"] == 5 and props["SURSTA"] == "20260101" and props["soundings"] == 10
    assert props["SOUACC"] == 2.5  # rounded up, never understated


def test_areas_and_contours_stop_at_200_m():
    bands = {band_index(100): box(0, 0, 1, 1), band_index(200): box(1, 0, 2, 1)}
    got = by_layer(overlay.tile_areas(([], [], []), PROPERTIES, bands, box(0, 0, 2, 1)))
    assert [f["properties"]["DRVAL1"] for f in got["DEPARE"]] == [100]
    # The 200 m contour is drawn, at the edge of the last published area.
    assert [f["properties"]["VALDCO"] for f in got["DEPCNT"]] == [200]


def test_a_real_surface_draws_its_200_m_contour(tmp_path):
    # 250 m water with a 150 m rise, through gdal_contour: the 200 m isobath closes
    # round the rise, and its least depth is prime.
    depth = np.full((60, 60), 250.0, dtype=np.float32)
    depth[20:40, 20:40] = 150.0
    path = tmp_path / "tile.tif"
    write_surface(path, -78, 33, depth, np.zeros_like(depth), np.ones_like(depth))
    bands, footprint, surfaced = overlay.surface_bands(path)
    rise = (-78 + 30 / 60, 33 + 30 / 60, 150.0)
    got = by_layer(overlay.tile_areas(tuple(zip(rise)), PROPERTIES, bands, footprint, surfaced))
    assert [f["properties"]["VALDCO"] for f in got["DEPCNT"]] == [200]
    assert [f["properties"]["DRVAL1"] for f in got["DEPARE"]] == [100]
    [prime] = got["SOUNDG"]
    assert prime["properties"]["depth_m"] == 150


def test_a_shoal_inside_a_closed_isobath_is_prime():
    deep = shapely.difference(box(0, 0, 3, 3), box(1, 1, 2, 2))
    bands = {band_index(2): box(1, 1, 2, 2), band_index(10): deep}
    candidates = ([1.4, 0.5], [1.6, 0.5], [3.4, 12.0])
    got = by_layer(overlay.tile_areas(candidates, PROPERTIES, bands, box(0, 0, 3, 3)))
    [prime] = got["SOUNDG"]
    assert prime["properties"]["depth_m"] == 3.4 and prime["properties"]["prime"] == 1
    assert prime["geometry"]["coordinates"] == [1.4, 1.6]
    # Open to the edge of coverage: no prime.
    assert "SOUNDG" not in by_layer(
        overlay.tile_areas(candidates, PROPERTIES, bands, box(1, 0, 3, 3))
    )
    # Inside coverage, but open to water the surface doesn't reach: no prime either.
    open_ = overlay.tile_areas(candidates, PROPERTIES, bands, box(0, 0, 3, 3), box(1, 0, 3, 3))
    assert "SOUNDG" not in by_layer(open_)


def test_a_drying_bank_has_its_area_drying_line_and_least_depth(tmp_path):
    # 3 m water round a bank that dries 0.5 m at chart datum, after tide reduction.
    depth = np.full((60, 60), 3.0, dtype=np.float32)
    depth[20:40, 20:40] = -0.5
    path = tmp_path / "tile.tif"
    write_surface(path, -78, 33, depth, np.zeros_like(depth), np.ones_like(depth))
    bands, footprint, surfaced = overlay.surface_bands(path)
    bank = (-78 + 30 / 60, 33 + 30 / 60, -0.5)
    got = by_layer(overlay.tile_areas(tuple(zip(bank)), PROPERTIES, bands, footprint, surfaced))
    areas = {(f["properties"]["DRVAL1"], f["properties"]["DRVAL2"]) for f in got["DEPARE"]}
    assert areas == {(overlay.DRYING_M, 0), (0, 2), (2, 5)}
    assert 0 in {f["properties"]["VALDCO"] for f in got["DEPCNT"]}
    assert -0.5 in {f["properties"]["depth_m"] for f in got["SOUNDG"]}


def write_surface(path, lon0, lat0, depth, distance, count):
    """A whole tile's bands as its surface COG, written as build_tile writes one."""
    sparse = path.with_suffix(".sparse.tif")
    with surface.open_sparse(sparse, lon0, lat0, depth.shape) as dst:
        dst.write(np.stack([depth, distance, count]))
    rasterio.shutil.copy(sparse, path, driver="COG", compress="deflate", sparse_ok=True)


def test_surface_bands_follow_the_surface(tmp_path):
    # A 1° tile, 100 pixels a side: 3 m in the west, 12 m in the east, nothing in the
    # north-east corner but one sounding the surface didn't reach.
    depth = np.full((100, 100), 12.0, dtype=np.float32)
    depth[:, :50] = 3.0
    depth[:20, 80:] = surface.NODATA
    count = np.zeros_like(depth)
    count[5, 95] = 1
    write_surface(tmp_path / "t.tif", -78, 33, depth, np.zeros_like(depth), count)
    bands, footprint, surfaced = overlay.surface_bands(tmp_path / "t.tif")
    # The surface is interpolated between pixels, so 3 m beside 12 m crosses the 5 m band.
    assert sorted(overlay.LEVELS[b] for b in bands) == [2, 5, 10]
    shoal = bands[band_index(2)]
    assert shoal.bounds[0] == pytest.approx(-78, abs=0.01) and shoal.bounds[2] < -77.48
    # Coverage reaches the lone sounding, grown by a pixel, but not the rest of the gap.
    assert footprint.contains(shapely.Point(-78 + 0.955, 34 - 0.055))
    assert not footprint.contains(shapely.Point(-78 + 0.85, 34 - 0.1))
    assert not surfaced.contains(shapely.Point(-78 + 0.955, 34 - 0.055))


def tile_of(lat0, lon0):
    return (lat0 + 90) * 360 + lon0 + 180


def put_tracks(env, tracks):  # noqa: F811
    for n, (vessel, rows) in enumerate(tracks, start=1):
        test_grid.put(env, n, [(t, *test_grid.at(r, c), d) for t, r, c, d in rows], vessel)


def surface_from(env, tracks):  # noqa: F811
    """Build cells from `tracks` (vessel, rows of (seconds, r, c, depth)) and grid the
    tile's surface; returns its depth band."""
    put_tracks(env, tracks)
    test_grid.build(env)
    tile = tile_of(test_grid.LAT0, test_grid.LON0)
    with open_store(env.store, write=False) as con:
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.cells").fetchall()
        path, _ = surface.build_tile(con, tile, partition, env.store.root / "surface")
    with rasterio.open(path) as src:
        return src.read(1)


def at_pixel(depth, r, c):
    return depth[surface.ROWS - 1 - r // 2, c // 2]


def parallel(depth=10.0, rows=(5000, 5012), length=60):
    """Two vessels along parallel tracks about 110 m apart (12 base rows), `length`
    base columns long (about 8 m each)."""
    return [(v, [(i, r, i, depth) for i in range(length)]) for v, r in zip("AB", rows)]


def test_surface_fills_between_tracks_but_not_past_their_ends(env):  # noqa: F811
    depth = surface_from(env, parallel())
    assert at_pixel(depth, 5006, 30) == pytest.approx(10.0, abs=0.5)  # between them
    # Past their ends, though within the radius of both: interpolating needs a
    # sounding on every side, so the surface doesn't run on beyond them.
    assert at_pixel(depth, 5006, 70) == surface.NODATA
    assert at_pixel(depth, 5300, 30) == surface.NODATA  # far from both


def test_skipping_empty_blocks_changes_no_pixel(env, monkeypatch):  # noqa: F811
    # Two tracks about 220 m apart either side of a corner of 64-pixel blocks: pixel
    # row 2880 starts a block, and its nearest sounding is 5 pixels north, in the
    # block before, past the blur's reach.
    # Varied depths, or a kilometre of one depth reads as a stuck sounder.
    put_tracks(env, [(v, [(i, r, i, 10 + i % 7 / 5) for i in range(300)]) for v, r in
                     (("A", 5026), ("B", 5048))])  # fmt: skip
    test_grid.build(env)
    tile = tile_of(test_grid.LAT0, test_grid.LON0)

    def bands(block):
        monkeypatch.setattr(surface, "BLOCK", block)
        with open_store(env.store, write=False) as con:
            [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.cells").fetchall()
            path, _ = surface.build_tile(con, tile, partition, env.store.root / str(block))
        with rasterio.open(path) as src:
            return src.read()

    # One block the size of the tile (rounded up to GeoTIFF's 16) is the whole raster.
    whole, blocked = bands(-(-surface.ROWS // 16) * 16), bands(64)
    data = (whole[0] != surface.NODATA) | (whole[2] > 0)
    assert data[2860:2900, 60:70].any() and data[2860:2900, 120:130].any()
    assert (blocked[:, data] == whole[:, data]).all()
    # Elsewhere, nothing: the skipped blocks aren't in the file at all.
    assert (blocked[0][~data] == surface.NODATA).all() and (blocked[2][~data] <= 0).all()
    assert (blocked[2] == surface.NODATA).any()


def test_surface_holds_a_confirmed_shoal_among_deeper_soundings(env):  # noqa: F811
    # Between two tracks, 30 vessels read 10 m in one base cell and two read 2 m there.
    tracks = parallel()
    tracks += [(f"V{i}", [(100 + i, 5006, 30, 10.0)]) for i in range(30)]
    tracks += [("R1", [(200, 5006, 30, 2.0)]), ("R2", [(201, 5006, 30, 2.3)])]
    depth = surface_from(env, tracks)
    assert at_pixel(depth, 5006, 30) <= 2.0


def test_surface_leaves_an_unconfirmed_shoal_empty(env):  # noqa: F811
    # A third track between the two reads a 3 m spike nobody else saw.
    tracks = parallel()
    tracks.append(("C", [(i, 5006, i, 3.0 if i == 30 else 10.0) for i in range(60)]))
    depth = surface_from(env, tracks)
    assert at_pixel(depth, 5006, 30) == surface.NODATA
    assert at_pixel(depth, 5006, 20) == pytest.approx(10.0, abs=0.5)


def test_surface_is_never_deeper_than_a_sounding_in_its_pixel():
    # A pixel interpolated to 7 m holds a sounding of 4 m; another holds an unconfirmed shoal.
    depth = np.full((10, 4), 10.0, dtype=np.float32)
    depth[5, 1] = 7.0
    shoalest = np.full(depth.shape, np.inf, dtype=np.float32)
    shoalest[5, 1] = 4.0
    unconfirmed = np.zeros(depth.shape, dtype=bool)
    unconfirmed[2, 2] = True
    out = surface.finish(depth, shoalest, unconfirmed)
    assert out[5, 1] == 4.0 and out[2, 2] == surface.NODATA
    # The blur never makes a pixel deeper than it was interpolated, guard or not.
    assert (out[~unconfirmed] <= depth[~unconfirmed]).all()
    nothing = np.full(depth.shape, np.inf, dtype=np.float32)
    assert (surface.finish(depth, nothing, np.zeros_like(unconfirmed)) <= depth).all()


def test_soundings_skip_latitudes_web_mercator_cant_hold(lake):
    lake.executemany(
        "INSERT INTO lake.cells (depth_lon, depth_lat, depth, kind) VALUES (?, ?, ?, ?)",
        [(0.0, -90.0, 3000.0, "single"), (10.0, 20.0, 50.0, "multi")],
    )
    assert {f["properties"]["depth_m"] for f in features(lake)} == {50}


def test_build_writes_pmtiles_with_every_layer(env, tmp_path):  # noqa: F811
    # A bank shoaling to 3 m across two tracks, and a lone track elsewhere.
    put_tracks(
        env,
        [
            (v, [(i, r, i, 3.0 if i < 30 else 12.0) for i in range(60)])
            for v, r in (("A", 5000), ("B", 5012))
        ],
    )
    test_grid.put(env, 9, [(i, *test_grid.at(7000, i), 20.0) for i in range(40)], "LONE")
    test_grid.build(env)
    with open_store(env.store, write=False) as con:
        counts = overlay.build(con, tmp_path)
    assert counts["soundings"] > 0 and counts["areas"] > 0
    decoded = subprocess.run(
        ["tippecanoe-decode", "-Z14", "-z14", str(tmp_path / "overlay.pmtiles")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    found = {
        layer["properties"]["layer"]
        for tile in json.loads(decoded)["features"]
        for layer in tile["features"]
    }
    assert {"SOUNDG", "DEPARE", "DEPCNT", "M_QUAL"} <= found
    with open(tmp_path / "overlay.pmtiles", "rb") as f:
        metadata = Reader(MmapSource(f)).metadata()
    assert metadata["type"] == "S-57" and metadata["version"] == str(overlay.GRID_VERSION)
    assert not (tmp_path / "overlay.mbtiles").exists()
    areas = [json.loads(line) for line in (tmp_path / "areas.geojsons").read_text().splitlines()]
    # The lone track's soundings sit inside coverage, though the surface can't reach them.
    [coverage] = [geometry(f) for f in areas if f["tippecanoe"]["layer"] == "M_QUAL"]
    # Its survey ends at the end of the cells' month or year, but never after today.
    [props] = [f["properties"] for f in areas if f["tippecanoe"]["layer"] == "M_QUAL"]
    assert props["SUREND"] == min(date(2026, 12, 31), date.today()).strftime("%Y%m%d")
    assert coverage.contains(shapely.Point(*test_grid.at(7000, 20)))
    # A prime sounding publishes once at any zoom, not again from the pyramid.
    sounds = [json.loads(ln) for ln in (tmp_path / "soundings.geojsons").read_text().splitlines()]
    primes = {
        tuple(f["geometry"]["coordinates"]): f["tippecanoe"]["minzoom"]
        for f in areas
        if f["properties"].get("prime")
    }
    for f in sounds:
        at = tuple(f["geometry"]["coordinates"])
        assert at not in primes or f["tippecanoe"].get("maxzoom", 99) < primes[at]


def test_souacc_rounds_up_from_the_depth_written():
    assert overlay.quality(None, None, 0, np.float32(2.2))["SOUACC"] == 2.2
    assert overlay.quality(None, None, 0, np.float32(2.21))["SOUACC"] == 2.3


def test_a_new_etag_on_the_same_content_keeps_cells_current(env):  # noqa: F811
    put_tracks(env, parallel())
    test_grid.build(env)
    with open_store(env.store) as con:
        built = cells.inputs(con)
        con.execute("UPDATE lake.files SET etag = 'reuploaded'")
        assert cells.inputs(con) == built


def test_a_withdrawal_makes_cells_stale(env):  # noqa: F811
    put_tracks(env, parallel())
    test_grid.build(env)
    with open_store(env.store) as con:
        built = cells.inputs(con)
        con.execute("UPDATE lake.files SET status = 'withdrawn' WHERE file_id = 1")
        assert cells.inputs(con) != built


def test_build_refuses_cells_older_than_the_store(env, tmp_path):  # noqa: F811
    put_tracks(env, parallel())
    test_grid.build(env)
    test_grid.put(env, 9, [(i, *test_grid.at(7000, i), 20.0) for i in range(40)], "LATER")
    env.run("noaa")  # ingested after the cells were built
    with open_store(env.store, write=False) as con, pytest.raises(RuntimeError, match="grid cells"):
        overlay.build(con, tmp_path)
    test_grid.build(env)
    with open_store(env.store, write=False) as con:
        assert overlay.build(con, tmp_path)["soundings"] > 0


def test_build_refuses_an_empty_store(env, tmp_path):  # noqa: F811
    with open_store(env.store) as con:
        cells.build(con)
    with open_store(env.store, write=False) as con, pytest.raises(RuntimeError, match="nothing"):
        overlay.build(con, tmp_path)


def test_surface_reaches_across_a_whole_degree_line(env):  # noqa: F811
    # Two tracks about 200 m apart, either side of the tile's northern edge.
    depth = surface_from(env, parallel(rows=(10790, 10812)))
    assert at_pixel(depth, 10799, 30) == pytest.approx(10.0, abs=0.5)


def test_a_one_pixel_shoal_covers_its_whole_pixel_in_the_areas(tmp_path):
    # 12 m everywhere but one pixel, which holds a 3 m sounding.
    depth = np.full((100, 100), 12.0, dtype=np.float32)
    shoalest = np.full(depth.shape, np.inf, dtype=np.float32)
    shoalest[50, 50] = 3.0
    out = surface.finish(depth, shoalest, np.zeros(depth.shape, dtype=bool))
    write_surface(tmp_path / "t.tif", -78, 33, out, np.zeros_like(out), np.zeros_like(out))
    bands, _, _ = overlay.surface_bands(tmp_path / "t.tif")
    shoal = shapely.union_all([a for b, a in bands.items() if overlay.LEVELS[b] < 5])
    # The pixel spans 0.01°; a sounding anywhere in it is inside the shoal's band.
    for fx, fy in ((0.1, 0.1), (0.9, 0.9), (0.1, 0.9), (0.5, 0.5)):
        assert shoal.contains(shapely.Point(-78 + (50 + fx) / 100, 34 - (50 + fy) / 100))


def test_soundings_leave_primes_to_the_areas(lake):
    lake.executemany(
        "INSERT INTO lake.cells (depth_lon, depth_lat, depth, kind) VALUES (?, ?, ?, ?)",
        [(-78.1234567, 33.1, 3.4, "multi"), (-77.5, 33.1, 12.0, "multi")],
    )
    got = list(overlay.soundings(lake, {(-78.123457, 33.1): 11}))
    # From z11 the prime shows it; below, the pyramid still does.
    assert {f["properties"]["depth_m"] for f in at_zoom(got, 11)} == {12}
    assert {f["properties"]["depth_m"] for f in at_zoom(got, 8)} == {3.4, 12}


def test_surface_reaches_across_the_antimeridian(env):  # noqa: F811
    # Two tracks about 280 m apart either side of 180°.
    lat0 = 33
    for n, (vessel, lon) in enumerate((("WEST", 179.9985), ("EAST", -179.9985)), start=1):
        test_grid.put(env, n, [(i, lon, lat0 + 0.5 + i / 10_000, 10.0) for i in range(60)], vessel)
    test_grid.build(env)
    tile = tile_of(lat0, 179)
    with open_store(env.store, write=False) as con:
        path, _ = surface.build_tile(con, tile, surface.partition_of(lat0, 179), env.store.root)
    with rasterio.open(path) as src:
        depth = src.read(1)
    # Between the tracks, inside this tile: filled from both sides of the line.
    row = surface.ROWS - 1 - int(0.502 * test_grid.cells.BASE / 2)
    assert depth[row, depth.shape[1] - 1] == pytest.approx(10.0, abs=1)


def test_float32_depths_label_as_written():
    # 20.9 is stored as float32 20.8999996; it labels 20.9, not 20.8.
    f = overlay.feature(0, 0, float(np.float32(20.9)), False, 10)
    assert f["properties"]["depth_m"] == 20.9 and f["properties"]["VALSOU"] == 20.9


def test_a_build_that_stops_partway_leaves_no_marker(env, monkeypatch):  # noqa: F811
    put_tracks(env, parallel())
    test_grid.build(env)

    def fail(*_):
        raise RuntimeError("stopped")

    monkeypatch.setattr(cells, "units", fail)
    with open_store(env.store, write=False) as con:
        assert con.execute("SELECT count(*) FROM lake.store_meta WHERE key = 'cells'").fetchone()[0]
        with pytest.raises(RuntimeError, match="stopped"):
            cells.build(con)
        assert not con.execute(
            "SELECT count(*) FROM lake.store_meta WHERE key = 'cells'"
        ).fetchone()[0]
