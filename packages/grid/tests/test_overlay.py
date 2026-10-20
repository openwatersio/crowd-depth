import json
import math
import subprocess
from datetime import UTC, date, datetime

import duckdb
import numpy as np
import pytest
import rasterio
import rasterio.shutil
import shapely
import test_grid
from pmtiles.reader import MmapSource, Reader
from test_grid import CSIG
from test_ingest import env  # noqa: F401  (env is a fixture)

from grid import cells, overlay, qc, statistic, surface
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


def test_deep_water_thins(lake):
    lake.executemany(
        "INSERT INTO lake.cells (depth_lon, depth_lat, depth, kind) VALUES (?, ?, ?, ?)",
        [(-70.0, 33.0, 250.0, "multi"), (-60.0, 33.0, 1500.0, "single")],
    )
    feats = features(lake)
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
    bands, footprint, surfaced, *_ = overlay.surface_bands(path)
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
    bands, footprint, surfaced, *_ = overlay.surface_bands(path)
    bank = (-78 + 30 / 60, 33 + 30 / 60, -0.5)
    got = by_layer(overlay.tile_areas(tuple(zip(bank)), PROPERTIES, bands, footprint, surfaced))
    areas = {(f["properties"]["DRVAL1"], f["properties"]["DRVAL2"]) for f in got["DEPARE"]}
    assert areas == {(overlay.DRYING_M, 0), (0, 2), (2, 5)}
    assert 0 in {f["properties"]["VALDCO"] for f in got["DEPCNT"]}
    assert -0.5 in {f["properties"]["depth_m"] for f in got["SOUNDG"]}


def write_surface(path, lon0, lat0, depth, distance, count, sigma=None):
    """A whole tile's bands as its surface COG, written as build_tile writes one."""
    sparse = path.with_suffix(".sparse.tif")
    sigma = np.zeros_like(depth) if sigma is None else sigma
    with surface.open_sparse(sparse, lon0, lat0, depth.shape) as dst:
        dst.write(np.stack([depth, distance, count, sigma]))
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
    bands, footprint, surfaced, *_ = overlay.surface_bands(tmp_path / "t.tif")
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


def surface_from(env, tracks, band=1):  # noqa: F811
    """Build cells from `tracks` (vessel, rows of (seconds, r, c, depth)) and grid the
    tile's surface; returns its depth band, or another of its bands."""
    put_tracks(env, tracks)
    test_grid.build(env)
    tile = tile_of(test_grid.LAT0, test_grid.LON0)
    with open_store(env.store, write=False) as con:
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.cells").fetchall()
        path = surface.build_tile(con, tile, partition, env.store.root / "surface")
    with rasterio.open(path) as src:
        return src.read(band)


def at_pixel(depth, r, c):
    return depth[surface.ROWS - 1 - r // 2, c // 2]


def parallel(depth=10.0, rows=(5000, 5012), length=60):
    """Two vessels along parallel tracks about 110 m apart (12 base rows), `length`
    base columns long (about 8 m each)."""
    return [(v, [(i, r, i, depth) for i in range(length)]) for v, r in zip("AB", rows)]


def test_surface_fills_between_tracks_but_not_past_their_ends(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(statistic, "SIGMA_PER_M", 0.0)  # σ without widening
    depth = surface_from(env, parallel())
    # Between them, 10 m less K σ: each track agrees with itself, so σ is the corrections'.
    assert at_pixel(depth, 5006, 30) == pytest.approx(10.0 - statistic.K * CSIG, abs=0.05)
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
            path = surface.build_tile(con, tile, partition, env.store.root / str(block))
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


def test_surface_holds_every_confirmed_shoal_among_deeper_soundings(env):  # noqa: F811
    # Between two tracks at 12 m, 20 vessels read 12 m in two base cells 60 m apart, and
    # two vessels read a shoal within the tolerance in each: 9.6 m and 9.9 m. Under 60
    # files, as a file's number is a seconds field in its key.
    tracks = [(v, [(i, r, i, 12.0) for i in range(60)]) for v, r in zip("AB", (5000, 5012))]
    for col, shoal in ((30, 9.6), (36, 9.9)):
        tracks += [(f"V{col}-{i}", [(100 + i, 5006, col, 12.0)]) for i in range(20)]
        tracks += [(f"R{col}-{i}", [(200 + i, 5006, col, shoal + 0.1 * i)]) for i in range(2)]
    depth = surface_from(env, tracks)
    assert at_pixel(depth, 5006, 30) <= 9.6 and at_pixel(depth, 5006, 36) <= 9.9


def test_a_contradicted_shoal_is_drawn_over_from_the_votes(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(statistic, "SIGMA_PER_M", 0.0)  # σ without widening
    # A third track between the two reads a 3 m spike its own track contradicts: the
    # surface is drawn from the other votes, and the spike publishes as a sounding.
    tracks = parallel()
    tracks.append(("C", [(i, 5006, i, 3.0 if i == 30 else 10.0) for i in range(60)]))
    depth = surface_from(env, tracks)
    assert ("unconfirmed", "spike", 3.0) in test_grid.flags(env)
    assert at_pixel(depth, 5006, 30) == pytest.approx(10.0 - statistic.K * CSIG, abs=0.05)
    assert (3.0,) in env.query("SELECT depth FROM lake.shoals")


def test_a_disproved_shoal_publishes_without_holding_the_surface_open(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(statistic, "SIGMA_PER_M", 0.0)
    # Four vessels read 10 m around a pixel where a fifth reads 5 m: consensus disproves
    # it, and shallower than HAZARD_M it stays an unconfirmed sounding.
    tracks = parallel()
    tracks += [(f"O{i}", [(100 + i, 5006, 28 + i, 10.0 + 0.1 * i)]) for i in range(4)]
    tracks.append(("ECHO", [(200, 5006, 30, 5.0)]))
    depth = surface_from(env, tracks)
    assert ("unconfirmed", "consensus_shoal", 5.0) in test_grid.flags(env)
    assert at_pixel(depth, 5006, 30) != surface.NODATA
    assert (5.0,) in env.query("SELECT depth FROM lake.shoals")


def test_surface_is_the_median_less_k_sigma_and_never_deeper_than_a_confirmed_shoal():
    # A pixel at 7 m less K σ holds a 4 m confirmed shoal. Shoaler soundings that aren't
    # confirmed shoals don't cap anything.
    surface_ = np.full((10, 4), 10.0, dtype=np.float32)
    surface_[5, 1] = 7.0
    sigma = np.full(surface_.shape, 0.5, dtype=np.float32)
    confirmed = np.full(surface_.shape, np.inf, dtype=np.float32)
    confirmed[5, 1] = 4.0
    out = surface.finish(surface_, sigma, surface.around(confirmed))
    assert out[5, 1] == 4.0
    # Carried to the pixels around it, never past them.
    assert out[4, 0] == 4.0 and out[7, 1] == pytest.approx(10.0 - statistic.K * 0.5)
    assert (out <= surface_ - statistic.K * 0.5 + 1e-6).all()
    # The blur never makes a pixel deeper than it was interpolated.
    assert (surface.blur(surface_) <= surface_).all()
    # The margin alone never makes wet water drying: a wide σ stops at 0 m.
    wide = np.full(surface_.shape, 50.0, dtype=np.float32)
    nothing = np.full(surface_.shape, np.inf)
    assert (surface.finish(surface_, wide, nothing) == 0).all()
    # Drying water stays drying, never past its median; a drying confirmed shoal stays put.
    drying = np.full(surface_.shape, -1.0, dtype=np.float32)
    assert (surface.finish(drying, wide, nothing) == -1).all()
    shoal = np.full(surface_.shape, -0.5, dtype=np.float32)
    assert (surface.finish(surface_, wide, shoal) == -0.5).all()


@pytest.mark.parametrize("reason, drawn", [("cell_shoal", False), ("cell_unjudged", True)])
def test_contradicted_shoals_dont_vote_and_unjudged_ones_do(env, tmp_path, reason, drawn):  # noqa: F811
    put_tracks(env, parallel())
    test_grid.build(env)
    tile = tile_of(test_grid.LAT0, test_grid.LON0)
    with open_store(env.store) as con:
        # As if every sounding were an unconfirmed shoal: contradicted by its cell, or in
        # a cell with no accepted median to judge it against.
        con.execute(
            "INSERT INTO lake.qc_flags SELECT point_id, 'unconfirmed', ?, ?, cell_id"
            " FROM lake.points",
            [reason, qc.QC_VERSION],
        )
        con.execute("DELETE FROM lake.qc_flags WHERE flag <> 'unconfirmed'")
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.cells").fetchall()
        path = surface.build_tile(con, tile, partition, tmp_path)
    with rasterio.open(path) as src:
        depth, count = src.read(1), src.read(3)
    assert (depth != surface.NODATA).any() == drawn and count[count > 0].sum() == 120


@pytest.mark.parametrize("depth, counted", [(10.0, 120), (40.0, 0)])
def test_a_transit_that_lost_the_bottom_never_votes(env, tmp_path, depth, counted):  # noqa: F811
    put_tracks(env, parallel(depth))
    test_grid.build(env)
    tile = tile_of(test_grid.LAT0, test_grid.LON0)
    with open_store(env.store) as con:
        # Calibration found both vessels' transits read far under the seabed.
        con.execute(
            "INSERT INTO lake.file_offsets SELECT file_id, vessel, NULL, NULL, false, true"
            " FROM lake.files"
        )
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.cells").fetchall()
        path = surface.build_tile(con, tile, partition, tmp_path)
    # Nothing votes, so nothing is drawn. Shoaler than HAZARD_M its soundings still band
    # the surface, as they publish as shoals; deeper they publish nowhere, and leave no tile.
    if not counted:
        assert path is None
        return
    with rasterio.open(path) as src:
        drawn, count = src.read(1), src.read(3)
    assert (drawn == surface.NODATA).all() and count[count > 0].sum() == counted


def test_interpolated_pixels_widen_with_distance_and_are_marked(env, monkeypatch, tmp_path):  # noqa: F811
    monkeypatch.setattr(statistic, "SIGMA_PER_M", 0.01)
    put_tracks(env, parallel())
    test_grid.build(env)
    tile = tile_of(test_grid.LAT0, test_grid.LON0)
    with open_store(env.store, write=False) as con:
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.cells").fetchall()
        path = surface.build_tile(con, tile, partition, tmp_path)
    with rasterio.open(path) as src:
        depth, distance, count, sigma = src.read()
    near, mid = (at_pixel(sigma, r, 30) for r in (5002, 5006))
    # The corrections' σ, wider with each metre from the nearest track.
    assert CSIG < near < mid
    assert mid == pytest.approx(math.hypot(CSIG, 0.01 * at_pixel(distance, 5006, 30)), abs=1e-4)
    assert at_pixel(count, 5006, 30) == 0 and at_pixel(distance, 5006, 30) > 40
    assert at_pixel(depth, 5006, 30) == pytest.approx(10.0 - statistic.K * mid, abs=0.05)
    # The overlay marks where the surface is drawn between tracks.
    bands, footprint, surfaced, interpolated, tvu = overlay.surface_bands(path)
    assert interpolated.contains(shapely.Point(*test_grid.at(5006, 30)))
    assert not interpolated.contains(shapely.Point(*test_grid.at(5000, 30)))
    assert tvu == pytest.approx(max(2 + 0.05 * float(depth[count == 0].min()), 1.96 * mid), abs=0.5)
    got = by_layer(
        overlay.tile_areas(([], [], []), PROPERTIES, bands, footprint, surfaced,
                           (interpolated, overlay.quality(None, None, 0, tvu)))
    )  # fmt: skip
    assert sorted(f["properties"]["kind"] for f in got["M_QUAL"]) == ["interpolated", "measured"]


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
    quality = {f["properties"]["kind"]: f for f in areas if f["tippecanoe"]["layer"] == "M_QUAL"}
    assert sorted(quality) == ["interpolated", "measured"]
    coverage = geometry(quality["measured"])
    # Its survey ends at the end of the cells' month or year, but never after today.
    props = quality["measured"]["properties"]
    # Capped at today in UTC, as DuckDB's current_date is in the store's UTC session.
    today = datetime.now(UTC).date()
    assert props["SUREND"] == min(date(2026, 12, 31), today).strftime("%Y%m%d")
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


def test_surface_reaches_across_a_whole_degree_line(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(statistic, "SIGMA_PER_M", 0.0)  # σ without widening
    # Two tracks about 200 m apart, either side of the tile's northern edge.
    depth = surface_from(env, parallel(rows=(10790, 10812)))
    assert at_pixel(depth, 10799, 30) == pytest.approx(10.0 - statistic.K * CSIG, abs=0.05)


def test_distance_counts_the_neighboring_tiles_soundings(env):  # noqa: F811
    # The track across the line is 4 base rows (about 40 m) from the pixel; this tile's is
    # 18 (about 185 m).
    distance = surface_from(env, parallel(rows=(10780, 10802)), band=2)
    assert 0 < at_pixel(distance, 10798, 30) < 60


def test_a_one_pixel_shoal_covers_its_whole_pixel_in_the_areas(tmp_path):
    # 12 m everywhere but one pixel, which holds a 3 m confirmed shoal.
    depth = np.full((100, 100), 12.0, dtype=np.float32)
    confirmed = np.full(depth.shape, np.inf, dtype=np.float32)
    confirmed[50, 50] = 3.0
    nothing = np.zeros(depth.shape, dtype=np.float32)
    out = surface.finish(depth, nothing, surface.around(confirmed))
    write_surface(tmp_path / "t.tif", -78, 33, out, np.zeros_like(out), np.zeros_like(out))
    bands, *_ = overlay.surface_bands(tmp_path / "t.tif")
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
        path = surface.build_tile(con, tile, surface.partition_of(lat0, 179), env.store.root)
    with rasterio.open(path) as src:
        depth = src.read(1)
    # Between the tracks, inside this tile: filled from both sides of the line.
    row = surface.ROWS - 1 - int(0.502 * test_grid.cells.BASE / 2)
    assert depth[row, depth.shape[1] - 1] == pytest.approx(10.0 - statistic.K * CSIG, abs=1)


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
