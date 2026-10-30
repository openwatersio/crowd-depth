import contextlib
import math
import re
import shutil
import sqlite3
from datetime import date, datetime, timedelta

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import transform_bounds
from test_grid import LAT0, LON0, T0, at, put
from test_ingest import env  # noqa: F401  (a fixture)

from grid import calibrate, catalog, cells, cli, ingest, overlay, tide
from grid import reference as reference_mod
from grid.catalog import open_store

TILE = (LAT0 + 90) * 360 + LON0 + 180


def corrected(env, columns="depth_raw, tide, offset_m, depth"):  # noqa: F811
    return env.query(
        f"""SELECT unique_id, time, {columns} FROM corrected_points_in(
          (SELECT any_value(cell_id) FROM lake.points), [], 0, 10800)
        ORDER BY unique_id, time"""
    )


# Tide


def stations():
    lon, lat = at(5000, 0)
    ok = {"commercial_use": True, "accepted": True, "has_datums": True, "chart_datum": "MLLW"}
    return [
        # Nearer, but licensed for non-commercial use only.
        {"id": "nc", "lon": lon, "lat": lat, **ok, "commercial_use": False},
        {
            "id": "far",
            "lon": lon + 0.2,
            "lat": lat,
            **ok,
            "license": "cc-by-4.0",
            "attribution": "Far station, CC BY 4.0",
        },
        {"id": "unsure", "lon": lon, "lat": lat, **ok, "accepted": False},
        # Levels about its own datum, near mean sea level, would read deeper than chart datum.
        {"id": "stnd", "lon": lon, "lat": lat, **ok, "chart_datum": "STND", "has_datums": False},
        # A lake gauge: its lowest low water is from its level record, not a tide.
        {"id": "lake", "lon": lon, "lat": lat, **ok, "chart_datum": "LLWLT", "diurnal_range": 0.08},
    ]


def levels(requests):
    """A level rising 1 m a day from 1 m at midnight."""
    return [
        [[t, 1 + (t - r["start"]) / 86400] for t in range(r["start"], r["end"] + 1, r["step"])]
        for r in requests
    ]


def residuals(gauge, month):
    start = datetime.combine(month, datetime.min.time())
    return [(start + timedelta(minutes=6 * i), 0.1) for i in range(31 * 240)]


def test_tide_from_the_nearest_open_station_and_its_gauge(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0), (900, lon, lat, 5.5)])
    env.run("noaa")
    gauges = [{"id": "g1", "lon": lon + 0.2, "lat": lat + 0.1}]
    with open_store(env.store) as con:
        later = date(2027, 1, 1)
        days = tide.build(
            con, stations, lambda: gauges, residuals, levels, version="v1", today=later
        )
        assert days == 1
        # Nothing new to do the second time, once the day is past refetching.
        assert (
            tide.build(con, stations, lambda: gauges, residuals, levels, version="v1", today=later)
            == 0
        )
    [(station, gauge, gauge_km)] = env.query(
        """SELECT s.station, s.gauge, s.gauge_km FROM lake.tide_cells
        JOIN lake.tide_stations s USING (station_id)"""
    )
    assert (station, gauge) == ("far", "g1")
    [(method, sigma)] = env.query("SELECT DISTINCT method, sigma FROM lake.tide_levels")
    assert method == "observed"
    assert sigma == pytest.approx(math.hypot(tide.OBSERVED_SIGMA, gauge_km * tide.GAUGE_KM_SIGMA))
    # T0 is 18:00, three quarters of the day's rise; 15 minutes later is a level
    # interpolated within its half hour.
    rows = corrected(env)
    assert len(rows) == 2
    for (_, t, raw, h, offset, depth), want in zip(rows, (1.85, 1.85 + 900 / 86400)):
        assert offset is None
        assert h == pytest.approx(want, abs=1e-6)
        assert depth == pytest.approx(raw - want, abs=1e-5)
    # The level's uncertainty widens with the station's distance, and the vessel's
    # offset, not calibrated, adds its own.
    [(km,)] = env.query("SELECT km FROM lake.tide_cells")
    for *_, s in corrected(env, "sigma"):
        want = math.hypot(sigma, km * 0.005, catalog.UNCALIBRATED_SIGMA)
        assert s == pytest.approx(want, rel=1e-5)


def test_no_station_in_reach_leaves_depths_raw(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    # A degree east: about 75 km from "far", past STATION_KM.
    put(env, 2, [(0, lon + 1, lat, 7.0)], "AQM-2")
    env.run("noaa")
    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, levels, version="v1")
    [(method, sigma)] = env.query("SELECT DISTINCT method, sigma FROM lake.tide_levels")
    assert (method, sigma) == ("predicted", pytest.approx(tide.PREDICTED_SIGMA))
    rows = {u: (raw, h, depth) for u, _, raw, h, _, depth in corrected(env)}
    assert rows["AQM-2"] == (7.0, None, 7.0)
    assert rows["AQM-1"][1] == pytest.approx(1.75)


def test_recent_days_take_a_gauges_late_data_and_mark_their_tiles(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    gauges = [{"id": "g1", "lon": lon + 0.2, "lat": lat + 0.1}]
    soon = date(2026, 10, 20)
    with open_store(env.store) as con:
        cells.build(con)
        tide.build(con, stations, lambda: gauges, residuals, levels, version="v1", today=soon)
        cells.build(con)
        assert cells.changed(con) == [] and cells.settled(con)

        def revised(gauge, month):
            return [(t, r + 0.2) for t, r in residuals(gauge, month)]

        tide.build(con, stations, lambda: gauges, revised, levels, version="v1", today=soon)
        assert cells.changed(con) == [TILE]
        cells.build(con, cells.changed(con))
        cells.done(con, [TILE])
        # Rebuilding the marked tile makes the cells current again.
        assert cells.settled(con)
    [(_, _, _, h, _, _)] = corrected(env)
    assert h == pytest.approx(1.75 + 0.3, abs=1e-6)
    built = env.query("SELECT value FROM lake.store_meta WHERE key = 'cells'")
    with open_store(env.store) as con:
        assert built == [(cells.inputs(con),)]


def test_old_days_that_gain_levels_mark_their_tiles(env):  # noqa: F811
    # Soundings from months back, gridded raw, then given tide levels.
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    with open_store(env.store) as con:
        cells.build(con)
        tide.build(con, stations, list, residuals, levels, version="v1", today=date(2027, 1, 1))
        assert cells.changed(con) == [TILE]


@pytest.mark.skipif(
    not shutil.which("node") or not (tide.PREDICT.parent / "node_modules").exists(),
    reason="needs node and `npm ci` in slackwater/",
)
def test_levels_come_from_the_slackwater_engine():
    stations = {s["id"]: s for s in tide.slackwater_stations()}
    cbbt = stations["noaa/8638863"]
    assert cbbt["commercial_use"] and cbbt["accepted"] and cbbt["chart_datum"] == "MLLW"
    [series] = tide.slackwater_levels(
        [{"station": "noaa/8638863", "start": 1717200000, "end": 1717203600, "step": 1800}]
    )
    # 2024-06-01 00:00Z at Chesapeake Bay Bridge Tunnel, as slackwater 1.0.0-beta.3 predicts it.
    assert [t for t, _ in series] == [1717200000, 1717201800, 1717203600]
    assert series[0][1] == pytest.approx(0.2504, abs=1e-3)


@pytest.mark.skipif(
    not shutil.which("node") or not (tide.PREDICT.parent / "node_modules").exists(),
    reason="needs node and `npm ci` in slackwater/",
)
def test_a_station_the_database_lacks_leaves_its_days_empty_every_time():
    known = {"station": "noaa/8638863", "start": 1717200000, "end": 1717203600, "step": 1800}
    unknown = known | {"station": "nowhere/1"}
    missing, again, series = tide.slackwater_levels([unknown, unknown, known])
    assert missing == again == []
    assert len(series) == 3


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
def test_a_database_that_wont_load_fails_the_run_rather_than_every_station(tmp_path, monkeypatch):
    # Empty series would mark the stations unpredictable, so their cells would move.
    modules = {
        "@slackwater/database": 'export const loadStations = () => Promise.reject(new Error("bad"));',
        "slackwater": 'export const findStation = () => Promise.reject(new Error("bad"));',
    }
    for name, source in modules.items():
        package = tmp_path / "node_modules" / name
        package.mkdir(parents=True)
        (package / "package.json").write_text('{"type": "module", "main": "index.js"}')
        (package / "index.js").write_text(source)
    helper = tmp_path / "predict.mjs"
    shutil.copy(tide.PREDICT, helper)
    monkeypatch.setattr(tide, "PREDICT", helper)
    request = {"station": "noaa/8638863", "start": 1717200000, "end": 1717203600, "step": 1800}
    with pytest.raises(RuntimeError, match="Slackwater helper failed"):
        tide.slackwater_levels([request])


# Calibration


def test_steps_split_where_offsets_move_and_not_on_noise():
    rng = np.random.default_rng(1)
    flat = rng.normal(-1, 0.1, 30)
    assert calibrate.steps(flat) == []
    stepped = np.concatenate([rng.normal(-1, 0.1, 12), rng.normal(-2, 0.1, 9)])
    assert calibrate.steps(stepped) == [12]
    # Too few transits on one side to call it a step.
    assert calibrate.steps(np.concatenate([np.full(12, -1.0), np.full(3, -2.0)])) == []
    # A shift smaller than STEP_M isn't one, however clean.
    assert calibrate.steps(np.concatenate([np.full(10, -1.0), np.full(10, -1.2)])) == []


def reference(path, cols, res=4, elevation=-10.0, rows=(4990, 5010)):
    """A flat surveyed seabed 10 m deep (NAVD88, separation 0) over base columns `cols`
    of rows 4990-5010, in UTM metres as BlueTopo is."""
    w, s = at(rows[0], cols[0], 0, 0)
    e, n = at(rows[1], cols[1], 0, 0)
    crs = "EPSG:32618"
    left, bottom, right, top = transform_bounds("EPSG:4326", crs, w, s, e, n)
    width, height = round((right - left) / res), round((top - bottom) / res)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=2,
        dtype="float32",
        crs=crs,
        transform=from_bounds(left, bottom, right, top, width, height),
        nodata=np.nan,
    ) as dst:
        dst.write(
            np.stack([np.full((height, width), elevation), np.full((height, width), 0.5)]).astype(
                "float32"
            )
        )
        dst.update_tags(VERTICALDATUMWKT='VERTCRS["navd88",VDATUM["navd88"]]')
    return str(path)


def transit(n, vessel, depth, cols, slot, r=5000):
    """One file, in its own 20 minutes: a sounding per 2/3″ pixel along a row, wobbling
    5 cm so it's no stuck sounder."""
    rows = [
        (slot * 1200 + i * 10, *at(r, c), depth + (0.05 if i % 2 else -0.05))
        for i, c in enumerate(range(cols[0], cols[1], 2))
    ]
    return n, rows, vessel


def calibrated(env, transits, ref, monkeypatch):  # noqa: F811
    for n, rows, vessel in transits:
        put(env, n, rows, vessel)
    env.run("noaa")
    monkeypatch.setattr("grid.reference.coops_separation", lambda: lambda lon, lat: 0.0)
    with open_store(env.store) as con:
        untided(con)
        return calibrate.run(con, [ref])


def untided(con):
    """Run tide with its only station out of reach, so depths stay as logged."""
    lon, lat = at(5000, 0)
    remote = {
        "id": "remote",
        "lon": lon + 5,
        "lat": lat,
        "commercial_use": True,
        "accepted": True,
        "has_datums": True,
        "chart_datum": "MLLW",
    }
    tide.build(con, lambda: [remote], list, residuals, levels, version="v1")


def segments(env):  # noqa: F811
    return {
        (v, s): (round(o, 2), st)
        for v, s, o, st in env.query(
            "SELECT vessel, segment, offset_m, status FROM lake.calibration ORDER BY ALL"
        )
    }


FLEET = [
    # Over the surveyed seabed and on into open water: anchored at -0.5.
    *(transit(1 + i, "AQM-A", 9.5, (0, 240), i) for i in range(3)),
    # Only where the survey isn't, crossing A: -1.2 from six crossing transits.
    *(transit(10 + i, "AQM-B", 8.8, (130, 190), 10 + i) for i in range(6)),
    # A sounder moved after six transits: -1.0, then -2.0.
    *(transit(20 + i, "AQM-C", 9.0, (130, 190), 20 + i) for i in range(6)),
    *(transit(30 + i, "AQM-C", 8.0, (130, 190), 30 + i) for i in range(6)),
    # Two crossing transits aren't enough to call it calibrated.
    *(transit(40 + i, "AQM-D", 7.0, (130, 190), 40 + i) for i in range(2)),
]


def test_offsets_per_step_segment_from_anchors_and_crossings(env, tmp_path, monkeypatch):  # noqa: F811
    ref = reference(tmp_path / "ref.tif", (0, 110))
    totals = calibrated(env, FLEET, ref, monkeypatch)
    assert totals["steps"] == 1
    # Within the 5 cm wobble, which a median of an even split lands on either side of.
    want = {
        ("AQM-A", 0): (-0.5, "anchored"),
        ("AQM-B", 0): (-1.2, "crossover"),
        ("AQM-C", 0): (-1.0, "crossover"),
        ("AQM-C", 1): (-2.0, "crossover"),
        ("AQM-D", 0): (-3.0, "uncalibrated"),
    }
    got = segments(env)
    assert got.keys() == want.keys()
    for key, (offset, status) in want.items():
        assert got[key][0] == pytest.approx(offset, abs=0.06) and got[key][1] == status
    # The step starts at C's first transit after it.
    [(start,)] = env.query(
        "SELECT t_start FROM lake.calibration WHERE vessel = 'AQM-C' AND segment = 1"
    )
    assert start == T0 + timedelta(seconds=30 * 1200)
    # Calibrated soundings read the surveyed 10 m, within their 5 cm wobble; D's read as logged.
    for u, _, raw, _, offset, depth in corrected(env):
        if u == "AQM-D":
            assert offset is None and depth == raw
        else:
            assert depth == pytest.approx(10.0, abs=0.11)
    assert env.query("SELECT DISTINCT tile_id, reason FROM lake.tile_changes") == [
        (TILE, "calibration")
    ]


def test_calibration_reads_a_dense_tile_in_bands_as_it_would_whole(env, monkeypatch):  # noqa: F811
    # Two vessels over rows 4990-5010: across a band edge (5004), with both rows of the
    # pixels beside an odd row (4995) sounded, so a band that split a pixel would show.
    for n, vessel in ((1, "AQM-A"), (2, "AQM-B")):
        cover = [(r, c) for r in range(4990, 5011) for c in range(n, 40, 3)]
        put(
            env,
            n,
            [(i * 2, *at(r, c), 9.0 + 0.1 * (i % 3)) for i, (r, c) in enumerate(cover)],
            vessel,
        )
    env.run("noaa")
    with open_store(env.store) as con:
        untided(con)
        calibrate.reduce(con)
        whole = sorted(con.execute("FROM cal_obs").fetchall())
        monkeypatch.setattr(cells, "BATCH_POINTS", 1)
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.points").fetchall()
        assert len(cells.units(con, partition, [], rows=18)) > 1
        calibrate.reduce(con)
        banded = sorted(con.execute("FROM cal_obs").fetchall())
    assert len(whole) > 100 and banded == whole


def test_a_noisy_tracks_soundings_dont_calibrate_its_vessel(env, tmp_path, monkeypatch):  # noqa: F811
    # A sounder hunting between 6 and 13 m over the surveyed 10 m: its 13 m side is noise
    # and its 6 m side unconfirmed shoals, so nothing it logged reaches calibration.
    ref = reference(tmp_path / "ref.tif", (0, 110))
    hunting = []
    for n, rows, vessel in (transit(1 + i, "AQM-H", 10.0, (0, 240), i) for i in range(3)):
        rows = [(s, lon, lat, 6.0 if j % 2 else 13.0) for j, (s, lon, lat, _) in enumerate(rows)]
        hunting.append((n, rows, vessel))
    calibrated(env, hunting, ref, monkeypatch)
    assert [status for (v, _), (_, status) in segments(env).items() if v == "AQM-H"] in (
        [],
        ["uncalibrated"],
    )


def test_offsets_republish_only_past_their_standard_error(env, tmp_path, monkeypatch):  # noqa: F811
    ref = reference(tmp_path / "ref.tif", (0, 110))
    calibrated(env, FLEET, ref, monkeypatch)
    with open_store(env.store) as con:
        cells.done(con, [TILE])
        before = segments(env)
        # The same soundings again: nothing moves, nothing goes stale.
        assert calibrate.run(con)["dirty_tiles"] == 0
    assert segments(env) == before
    # One more transit of B a centimetre off: inside its standard error, so kept.
    n, rows, v = transit(50, "AQM-B", 8.79, (130, 190), 50)
    put(env, n, rows, v)
    env.run("noaa")
    [(old,)] = env.query("SELECT offset_m FROM lake.calibration WHERE vessel = 'AQM-B'")
    with open_store(env.store) as con:
        calibrate.run(con)
    [(new,)] = env.query("SELECT offset_m FROM lake.calibration WHERE vessel = 'AQM-B'")
    assert new == old
    # The new file takes its segment's offset, so only its tile is stale.
    assert env.query("SELECT DISTINCT tile_id FROM lake.tile_changes") == [(TILE,)]


def test_an_offset_that_moves_past_its_standard_error_republishes(env, tmp_path, monkeypatch):  # noqa: F811
    ref = reference(tmp_path / "ref.tif", (0, 110))
    calibrated(env, FLEET, ref, monkeypatch)
    with open_store(env.store) as con:
        cells.done(con, [TILE])
    # Twelve more transits of B a quarter metre shallower, too little to be a step, pull
    # its offset well past its standard error.
    for i in range(12):
        put(env, *transit(42 + i, "AQM-B", 8.55, (130, 190), 50 + i)[:2], "AQM-B")
    env.run("noaa")
    [(old,)] = env.query("SELECT offset_m FROM lake.calibration WHERE vessel = 'AQM-B'")
    with open_store(env.store) as con:
        calibrate.run(con)
    [(new, se)] = env.query("SELECT offset_m, se_m FROM lake.calibration WHERE vessel = 'AQM-B'")
    assert abs(new - old) > se
    assert env.query("SELECT DISTINCT tile_id FROM lake.tile_changes") == [(TILE,)]


def test_cells_use_corrected_depths_and_count_corrections(env, tmp_path, monkeypatch):  # noqa: F811
    ref = reference(tmp_path / "ref.tif", (0, 110))
    calibrated(env, FLEET, ref, monkeypatch)
    with open_store(env.store) as con:
        assert cells.changed(con) == [TILE]
        cells.build(con, cells.changed(con))
        cells.done(con, [TILE])
        assert cells.changed(con) == []
    rows = env.query(
        """SELECT median, count, tided, calibrated FROM lake.cells
        WHERE col * level * 1 >= 130"""
    )
    assert rows
    for median, count, tided, calibrated_ in rows:
        # D's uncalibrated 7 m soundings are shoals nothing confirms, out of the cells.
        assert tided == 0 and calibrated_ == count
        assert median == pytest.approx(10.0, abs=0.11)


def test_a_store_with_nothing_to_calibrate_publishes_nothing(env):  # noqa: F811
    with open_store(env.store) as con:
        untided(con)
        assert calibrate.run(con)["segments"] == 0
    assert env.query("SELECT count(*) FROM lake.calibration") == [(0,)]


def test_offsets_past_the_plausible_range_are_never_applied(env, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr(calibrate, "OFFSET_RANGE_M", (-1.1, 3.0))
    ref = reference(tmp_path / "ref.tif", (0, 110))
    calibrated(env, FLEET, ref, monkeypatch)
    got = segments(env)
    assert got[("AQM-A", 0)][1] == "anchored"
    assert got[("AQM-B", 0)][1] == got[("AQM-C", 1)][1] == "rejected"
    applied = {u for u, *_, offset, _ in corrected(env) if offset is not None}
    assert applied == {"AQM-A", "AQM-C"}


def test_a_source_added_later_samples_the_pixels_others_missed(env, tmp_path, monkeypatch):  # noqa: F811
    calibrated(env, FLEET, reference(tmp_path / "left.tif", (0, 110)), monkeypatch)
    assert segments(env)[("AQM-B", 0)][1] == "crossover"
    (tmp_path / "right").mkdir()
    right = reference(tmp_path / "right" / "right.tif", (130, 190))
    with open_store(env.store) as con:
        calibrate.run(con, [right])
    # The later source is sampled at the pixels the first didn't cover.
    covered = env.query(
        f"""SELECT count(*) FROM lake.reference_pixels
        WHERE source = '{right}' AND depth IS NOT NULL"""
    )
    assert covered == [(30,)]


def test_the_overlay_credits_the_stations_and_surveys_it_used(env, tmp_path, monkeypatch):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    with open_store(env.store) as con:
        assert overlay.attribution(con) == "Crowd Depth, NOAA DCDB crowdsourced bathymetry"
        tide.build(con, stations, list, residuals, levels, version="v1")
        credit = overlay.attribution(con)
    assert "Slackwater" in credit and "Far station, CC BY 4.0" in credit


def test_the_first_tide_run_on_a_built_grid_settles_after_its_tiles(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    with open_store(env.store) as con:
        cells.build(con)
        tide.build(con, stations, list, residuals, levels, version="v1", today=date(2027, 1, 1))
        assert cells.settled(con) and cells.changed(con) == [TILE]
        cells.build(con, cells.changed(con))
        cells.done(con, [TILE])
        assert env_marker(con) == cells.inputs(con)


def env_marker(con):
    [(value,)] = con.execute("SELECT value FROM lake.store_meta WHERE key = 'cells'").fetchall()
    return value


def test_a_station_that_leaves_hands_its_cells_to_the_next(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    later = date(2027, 1, 1)
    near = {
        "id": "near",
        "lon": lon + 0.1,
        "lat": lat,
        "commercial_use": True,
        "accepted": True,
        "has_datums": True,
        "chart_datum": "MLLW",
    }
    with open_store(env.store) as con:
        tide.build(
            con, lambda: [*stations(), near], list, residuals, levels, version="v1", today=later
        )
        cells.build(con)
        # The next release drops "near": its cells go to "far", and their tiles are stale.
        tide.build(con, stations, list, residuals, levels, version="v1", today=later)
        assert cells.changed(con) == [TILE]
        [(station,)] = con.execute(
            """SELECT s.station FROM lake.tide_cells JOIN lake.tide_stations s USING (station_id)"""
        ).fetchall()
        assert station == "far"
        assert con.execute(
            "SELECT count(*) FROM lake.tide_stations WHERE station = 'near'"
        ).fetchone() == (0,)


def test_cells_an_older_build_wrote_are_never_settled(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    with open_store(env.store) as con:
        cells.build(con)
        assert cells.settled(con)
        con.execute("UPDATE lake.cells SET grid_version = grid_version - 1")
        assert not cells.settled(con)


def test_gauges_without_residuals_and_faulty_readings(monkeypatch):
    replies = {
        "water_level": {
            "data": [{"t": "2026-01-01 00:00", "v": "1.0"}, {"t": "2026-01-01 00:06", "v": "9.0"}]
        },
        "predictions": {
            "predictions": [
                {"t": "2026-01-01 00:00", "v": "0.8"},
                {"t": "2026-01-01 00:06", "v": "0.8"},
            ]
        },
    }
    monkeypatch.setattr(tide, "_get", lambda url, params: replies[params["product"]])
    # An 8.2 m residual is a faulty reading, not weather.
    assert tide.coops_residuals("g", date(2026, 1, 1)) == [
        (datetime(2026, 1, 1), pytest.approx(0.2))
    ]
    # A Great Lakes gauge has neither MLLW nor predictions: no residual, not a failure.
    replies["water_level"] = {"error": {"message": "There is no MLLW for the station: 9063020"}}
    replies["predictions"] = {
        "error": {"message": "Great Lakes stations don't have Predictions data."}
    }
    assert tide.coops_residuals("9063020", date(2026, 1, 1)) == []
    replies["water_level"] = {"error": {"message": "Service unavailable"}}
    with pytest.raises(RuntimeError):
        tide.coops_residuals("g", date(2026, 1, 1))


def test_a_point_on_a_tiles_edge_is_in_a_tide_cell_of_its_tile(env):  # noqa: F811
    lon, lat = at(0, 0)
    put(env, 1, [(0, lon, LAT0 + 1 - 1e-15, 5.0), (10, LON0 + 1 - 1e-15, lat, 5.0)])
    env.run("noaa")
    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, levels, version="v1", today=date(2027, 1, 1))
    cells_ = env.query("SELECT tide_cell, tile_id FROM lake.tide_cells")
    assert len(cells_) == 2 and len({c for c, _ in cells_}) == 2
    for cell, tile in cells_:
        assert (cell // 18000 // 50, cell % 18000 // 50) == (tile // 360, tile % 360)


def test_a_store_built_before_correction_columns_gains_them(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    with open_store(env.store) as con:
        con.execute("ALTER TABLE lake.cells DROP COLUMN tided")
        con.execute("ALTER TABLE lake.cells DROP COLUMN calibrated")
    with open_store(env.store) as con:
        cells.build(con)
    assert env.query("SELECT count(tided), count(calibrated) FROM lake.cells")[0][0] > 0


def test_most_stations_leaving_at_once_is_refused(env, monkeypatch):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    monkeypatch.setattr(tide, "GUARDED_STATIONS", 1)
    near = {
        "id": "near",
        "lon": lon + 0.05,
        "lat": lat,
        "commercial_use": True,
        "accepted": True,
        "has_datums": True,
        "chart_datum": "MLLW",
    }
    with open_store(env.store) as con:
        tide.build(con, lambda: [*stations(), near], list, residuals, levels, version="v1")
        with pytest.raises(RuntimeError, match="would leave at once"):
            tide.build(con, stations, list, residuals, levels, version="v1")


def test_a_new_engine_version_predicts_every_level_again(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    later = date(2027, 1, 1)
    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, levels, version="v1", today=later)
        cells.build(con)

        def revised(requests):
            return [[[t, h + 0.1] for t, h in s] for s in levels(requests)]

        assert tide.build(con, stations, list, residuals, revised, version="v2", today=later) == 1
        assert cells.changed(con) == [TILE]
    [(_, _, _, h, _, _)] = corrected(env)
    assert h == pytest.approx(1.85, abs=1e-6)


def test_a_station_that_joins_nearer_takes_the_cells_over(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    later = date(2027, 1, 1)
    near = {
        "id": "near",
        "lon": lon + 0.05,
        "lat": lat,
        "commercial_use": True,
        "accepted": True,
        "has_datums": True,
        "chart_datum": "MLLW",
    }
    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, levels, version="v1", today=later)
        cells.build(con)
        tide.build(
            con, lambda: [*stations(), near], list, residuals, levels, version="v1", today=later
        )
        assert cells.changed(con) == [TILE]
    [(station,)] = env.query(
        "SELECT s.station FROM lake.tide_cells JOIN lake.tide_stations s USING (station_id)"
    )
    assert station == "near"


def test_a_day_the_engine_cant_predict_is_never_marked(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")

    def blank(requests):
        return [[[t, None] for t, _ in s] for s in levels(requests)]

    with open_store(env.store) as con:
        cells.build(con)
        tide.build(con, stations, list, residuals, blank, version="v1", today=date(2027, 1, 1))
        assert con.execute("SELECT count(*) FROM lake.tide_levels").fetchone() == (0,)
        assert cells.changed(con) == []


def test_offsets_solved_before_tide_block_the_overlay(env, tmp_path, monkeypatch):  # noqa: F811
    ref = reference(tmp_path / "ref.tif", (0, 110))
    calibrated(env, FLEET, ref, monkeypatch)
    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, levels, version="v1", today=date(2027, 1, 1))
        cells.build(con)
        with pytest.raises(RuntimeError, match="since calibration"):
            overlay.build(con, tmp_path / "out")
        calibrate.run(con)
        cells.build(con)
        assert con.execute(
            "SELECT value FROM lake.store_meta WHERE key = 'calibration_tide'"
        ).fetchone() == (cells.tides(con),)


def test_soundings_awaiting_their_tide_stay_out_of_calibration(env, tmp_path, monkeypatch):  # noqa: F811
    for n, rows, vessel in FLEET:
        put(env, n, rows, vessel)
    env.run("noaa")

    def blank(requests):
        return [[[t, None] for t, _ in s] for s in levels(requests)]

    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, blank, version="v1", today=date(2027, 1, 1))
        assert calibrate.run(con)["segments"] == 0


def test_the_finest_raster_of_a_source_wins(env, tmp_path, monkeypatch):  # noqa: F811
    refs = tmp_path / "refs"
    refs.mkdir()
    # Named to sort first: a coarse tile around the fine one, a metre off.
    reference(refs / "a_coarse.tif", (0, 110), res=16, elevation=-11.0)
    reference(refs / "b_fine.tif", (0, 110))
    calibrated(env, FLEET, str(refs), monkeypatch)
    assert segments(env)[("AQM-A", 0)][0] == pytest.approx(-0.5, abs=0.06)


def test_a_catalog_tile_with_no_link_yet_is_tried_again(tmp_path):
    path = tmp_path / "scheme.gpkg"
    with contextlib.closing(sqlite3.connect(path)) as db:
        db.execute("CREATE TABLE t (fid INTEGER PRIMARY KEY, link TEXT, sha TEXT)")
        db.execute('CREATE VIRTUAL TABLE "rtree_t_geom" USING rtree(id, minx, maxx, miny, maxy)')
        db.executemany("INSERT INTO t VALUES (?, ?, NULL)", [(1, "https://x/a.tif"), (2, None)])
        db.executemany('INSERT INTO "rtree_t_geom" VALUES (?, 0, 1, 0, 1)', [(1,), (2,)])
        db.commit()
    catalogs = {"bluetopo": (path, "t", "link", "sha", False)}
    paths, pending = reference_mod.rasters("bluetopo", (0, 0, 1, 1), catalogs)
    assert paths == ["/vsicurl/https://x/a.tif"] and pending == [[0, 0, 1, 1]]


def test_a_segment_reading_too_deep_to_correct_is_left_out(env, tmp_path, monkeypatch):  # noqa: F811
    # A reads 4 m deep: past any plausible offset, and in the unsafe direction.
    deep = [transit(1 + i, "AQM-A", 14.0, (0, 240), i) for i in range(3)]
    calibrated(env, [*deep, *FLEET[3:]], reference(tmp_path / "ref.tif", (0, 110)), monkeypatch)
    assert segments(env)[("AQM-A", 0)][1] == "rejected"
    excluded = {u for u, *_, x in corrected(env, "excluded") if x}
    assert excluded == {"AQM-A"}
    with open_store(env.store) as con:
        cells.build(con)
    assert env.query("SELECT count(*) FROM lake.cells WHERE col < 55") == [(0,)]


def test_a_late_file_takes_its_segments_offset(env, tmp_path, monkeypatch):  # noqa: F811
    calibrated(env, FLEET, reference(tmp_path / "ref.tif", (0, 110)), monkeypatch)
    put(env, *transit(50, "AQM-B", 8.8, (130, 190), 50)[:2], "AQM-B")
    env.run("noaa")
    with open_store(env.store) as con:
        calibrate.assign(con)
    got = {u: o for u, *_, o, _ in corrected(env) if u == "AQM-B"}
    assert got["AQM-B"] == pytest.approx(-1.2, abs=0.06)
    assert all(o is not None for u, *_, o, _ in corrected(env) if u == "AQM-B")


def test_a_run_that_would_drop_most_offsets_is_refused(env, tmp_path, monkeypatch):  # noqa: F811
    calibrated(env, FLEET, reference(tmp_path / "ref.tif", (0, 110)), monkeypatch)
    monkeypatch.setattr(calibrate, "GUARDED_SEGMENTS", 1)
    with open_store(env.store) as con:
        # The reference gone: nothing anchors, so nothing would be calibrated.
        con.execute("DELETE FROM lake.reference_pixels")
        with pytest.raises(RuntimeError, match="down from"):
            calibrate.run(con)


def test_soundings_tide_hasnt_seen_stay_out_of_calibration(env, tmp_path, monkeypatch):  # noqa: F811
    calibrated(env, FLEET, reference(tmp_path / "ref.tif", (0, 110)), monkeypatch)
    # A new vessel 5 km north, in cells `grid tide` hasn't assigned yet.
    for i in range(6):
        put(env, *transit(42 + i, "AQM-E", 8.0, (130, 190), 50 + i, r=5000 + 270)[:2], "AQM-E")
    env.run("noaa")
    with open_store(env.store) as con:
        calibrate.run(con)
    assert "AQM-E" not in {v for v, _ in segments(env)}


def test_a_gauges_weather_holds_through_the_months_last_half_hour(env):  # noqa: F811
    lon, lat = at(5000, 0)
    last = (datetime(2026, 9, 30, 23, 45) - T0).total_seconds()
    put(env, 1, [(last, lon, lat, 5.0)])
    env.run("noaa")
    gauges = [{"id": "g1", "lon": lon + 0.2, "lat": lat + 0.1}]
    with open_store(env.store) as con:
        tide.build(
            con, stations, lambda: gauges, residuals, levels, version="v1", today=date(2027, 1, 1)
        )
    [(*_, h, _, _)] = corrected(env)
    assert h == pytest.approx(1 + (23.75 / 24) + 0.1, abs=1e-6)


def test_a_gauge_that_cant_be_reached_falls_back_to_predictions_and_retries(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    gauges = [{"id": "g1", "lon": lon + 0.2, "lat": lat + 0.1}]
    later = date(2027, 1, 1)

    def refused(gauge, month):
        raise OSError("HTTP Error 403: Forbidden")

    with open_store(env.store) as con:
        tide.build(con, stations, lambda: gauges, refused, levels, version="v1", today=later)
        assert con.execute("SELECT DISTINCT method FROM lake.tide_levels").fetchall() == [
            ("predicted",)
        ]
        # Reachable again: the month is fetched and its days levelled with the weather.
        tide.build(con, stations, lambda: gauges, residuals, levels, version="v1", today=later)
        assert con.execute("SELECT DISTINCT method FROM lake.tide_levels").fetchall() == [
            ("observed",)
        ]


def test_a_step_too_few_transits_show_leaves_them_alone(env, tmp_path, monkeypatch):  # noqa: F811
    # The Chesapeake's articulated tug-barge: two transits reading 0.3 m deep, then its
    # sounder moved, and ten reading 4.6 m shallow. Two transits can't make a step, so
    # the segment's offset is the ten's; the two early ones mustn't take it.
    ref = reference(tmp_path / "ref.tif", (0, 240), rows=(4990, 5110))
    tug = [
        *(transit(1 + i, "AQM-T", 10.3, (0, 110), i, r=5100) for i in range(2)),
        *(transit(10 + i, "AQM-T", 5.4, (0, 240), 10 + i) for i in range(10)),
        *(transit(30 + i, "AQM-A", 9.5, (0, 240), 30 + i) for i in range(3)),
    ]
    calibrated(env, tug, ref, monkeypatch)
    [(offset, status)] = env.query(
        "SELECT offset_m, status FROM lake.calibration WHERE vessel = 'AQM-T'"
    )
    assert status == "anchored" and offset == pytest.approx(-4.6, abs=0.1)
    early = {f for (f,) in env.query("SELECT file_id FROM lake.calibration_outliers")}
    assert len(early) == 2
    for u, _, raw, _, ofs, depth in corrected(env):
        if u == "AQM-T" and raw > 10:
            assert ofs is None and depth == raw  # read as logged, uncalibrated
    with open_store(env.store) as con:
        cells.build(con)
    # No cell over the early transits is drawn deeper than they read.
    deepest = env.query(
        """SELECT max(depth) FROM lake.cells
        WHERE "row" * level <= 5100 AND ("row" + 1) * level > 5100"""
    )[0][0]
    assert deepest is not None and deepest <= 10.35 + 1e-4


def test_a_transit_that_lost_the_bottom_publishes_shoals(env, tmp_path, monkeypatch):  # noqa: F811
    # ROSEP-607cc5a5 at the Chesapeake's mouth: calibrated, then two transits reading a stuck
    # 0.8 m over 10 m of seabed, where its segment reads 5.4 m: lost bottom, not a draft.
    ref = reference(tmp_path / "ref.tif", (0, 240))
    fleet = [
        *(transit(1 + i, "AQM-T", 5.4, (0, 240), i) for i in range(10)),
        *(transit(20 + i, "AQM-T", 0.8, (0, 240), 20 + i) for i in range(2)),
        *(transit(30 + i, "AQM-A", 9.5, (0, 240), 30 + i) for i in range(3)),
    ]
    calibrated(env, fleet, ref, monkeypatch)
    assert env.query("SELECT count(*) FROM lake.lost_runs") == [(2,)]
    got = {raw: c for u, _, raw, c in corrected(env, "depth_raw, lost_bottom") if u == "AQM-T"}
    assert {round(raw) for raw, c in got.items() if c} == {1}
    assert not any(c for raw, c in got.items() if raw > 5)
    with open_store(env.store) as con:
        cells.build(con)
    # The cells are drawn from the other transits, 10 m deep, never from the lost ones...
    assert env.query("SELECT min(depth) FROM lake.cells")[0][0] > 9
    # ...which still publish, as unconfirmed shoals.
    assert env.query("SELECT count(*), max(depth) FROM lake.shoals")[0] == (
        pytest.approx(len(fleet[10][1]) * 2, rel=0.1),
        pytest.approx(0.85, abs=0.01),
    )


def stuck(n, vessel, depth, slot, cols=(0, 240), step=2):
    """A transit reading `depth` wandering a tenth either way, one sounding per `step`
    columns (step 0: sitting still)."""
    rows = [
        (slot * 1200 + i * 10, *at(5000, cols[0] + i * step), depth + 0.1 * (i % 3 - 1))
        for i in range((cols[1] - cols[0]) // 2)
    ]
    return n, rows, vessel


@pytest.mark.parametrize(
    "case, runs",
    [
        ("moving", 1),  # 120 soundings over 2 km
        ("moored", 0),  # 120 soundings where it lies
        ("approach", 0),  # reading lost but unsteady over 1 km, then where it lies
        ("short", 0),  # 88 soundings: 59 steady once the window fills, one under STUCK_RUN
    ],
)
def test_a_stuck_run_must_last_and_go_somewhere(env, tmp_path, monkeypatch, case, runs):  # noqa: F811
    lost = {
        "moving": stuck(20, "AQM-T", 0.8, 20),
        "moored": stuck(20, "AQM-T", 0.8, 20, step=0),
        "approach": (
            20,
            [(24000 + i * 10, *at(5000, i * 2), 2.5 - 0.02 * i) for i in range(60)]
            + [(24600 + i * 10, *at(5000, 120), 0.8 + 0.1 * (i % 3 - 1)) for i in range(120)],
            "AQM-T",
        ),
        "short": stuck(20, "AQM-T", 0.8, 20, cols=(0, 176)),
    }[case]
    fleet = [
        *(transit(1 + i, "AQM-T", 5.4, (0, 240), i) for i in range(10)),
        lost,
        *(transit(30 + i, "AQM-A", 9.5, (0, 240), 30 + i) for i in range(3)),
    ]
    calibrated(env, fleet, reference(tmp_path / "ref.tif", (0, 240)), monkeypatch)
    assert env.query("SELECT count(*) FROM lake.lost_runs") == [(runs,)]


@pytest.mark.parametrize(
    "good, share, months, runs",
    [
        (10, 0.05, 0, 1),  # one transit lost in 11: its stuck run alone
        (10, 0.5, 0, 0),  # no month at STUCK_SHARE: not looked for
        (3, 0.05, 4, 1),  # one in 4: the month's files set aside whole
    ],
)
def test_a_month_mostly_lost_is_set_aside(env, tmp_path, monkeypatch, good, share, months, runs):  # noqa: F811
    monkeypatch.setattr(calibrate, "MONTH_PIXELS", 1)
    monkeypatch.setattr(calibrate, "STUCK_SHARE", share)
    fleet = [
        *(transit(1 + i, "AQM-T", 5.4, (0, 240), i) for i in range(good)),
        stuck(20, "AQM-T", 0.8, 20),
        *(transit(30 + i, "AQM-A", 9.5, (0, 240), 30 + i) for i in range(3)),
    ]
    calibrated(env, fleet, reference(tmp_path / "ref.tif", (0, 240)), monkeypatch)
    assert env.query(
        "SELECT count(*) FILTER (WHERE tile_id IS NULL), count(*) FILTER (WHERE tile_id IS NOT NULL)"
        " FROM lake.lost_runs"
    ) == [(months, runs)]


def test_a_stuck_run_holds_through_a_stray_reading(env, tmp_path, monkeypatch):  # noqa: F811
    # One reading in 15 jumps to 1.6 m: still lost, and two to a window, under its top tenth.
    n, rows, vessel = stuck(20, "AQM-T", 0.8, 20)
    rows = [(ts, x, y, 1.6 if i % 15 == 7 else d) for i, (ts, x, y, d) in enumerate(rows)]
    fleet = [
        *(transit(1 + i, "AQM-T", 5.4, (0, 240), i) for i in range(10)),
        (n, rows, vessel),
        *(transit(30 + i, "AQM-A", 9.5, (0, 240), 30 + i) for i in range(3)),
    ]
    calibrated(env, fleet, reference(tmp_path / "ref.tif", (0, 240)), monkeypatch)
    assert env.query("SELECT count(*) FROM lake.lost_runs") == [(1,)]


def test_stuck_runs_are_searched_where_a_vessel_holds_only_held_depths(env):  # noqa: F811
    # Two searched vessels over two tiles: B has medians only in the first, and A only in
    # the second, so each tile is searched for both.
    second = TILE + 1
    put(env, 1, [(i, *at(5000, i), 5.0) for i in range(10)], "AQM-A")
    put(env, 2, [(i, *at(5000, cells.BASE + i), 5.0) for i in range(10)], "AQM-A")
    put(env, 3, [(i, *at(5000, i), 5.0) for i in range(10)], "AQM-B")
    put(env, 4, [(i, *at(5000, cells.BASE + i), 5.0) for i in range(10)], "AQM-B")
    env.run("noaa")
    with open_store(env.store) as con:
        con.execute(
            "CREATE TEMP TABLE cal_obs AS SELECT * FROM (VALUES (?, 'AQM-A'), (?, 'AQM-B'))"
            " t(tile_id, vessel)",
            [second, TILE],
        )
        con.execute(
            "CREATE TEMP TABLE stuck_vessels AS SELECT 'AQM-A' AS vessel UNION SELECT 'AQM-B'"
        )
        got = {(t, v) for _, t, v in calibrate.stuck_pairs(con)}
    assert got == {(t, v) for t in (TILE, second) for v in ("AQM-A", "AQM-B")}


def test_stuck_run_windows_order_soundings_the_same_every_time():
    # Soundings of one file can share a time and depth: ordered by those alone, which of
    # them a window holds, and so the runs found, could change from run to run.
    orders = re.findall(r"ORDER BY ([^)\n]*?)(?:\s+ROWS|\)|\n)", calibrate.STUCK)
    assert len(orders) == 4 and all(o.strip() == "time, raw, row" for o in orders), orders


def test_a_sounder_holding_one_depth_is_a_stuck_run(env, tmp_path, monkeypatch):  # noqa: F811
    # It wanders, then holds 0.8 m to the centimetre for its last 70 soundings, over 1 km:
    # QC's flatline, unconfirmed, and still part of the run. Calibration's pixels leave the
    # flatline out, so the month's share is the wandering half's.
    monkeypatch.setattr(calibrate, "STUCK_SHARE", 0.01)
    n, rows, vessel = stuck(20, "AQM-T", 0.8, 20)
    fleet = [
        *(transit(1 + i, "AQM-T", 5.4, (0, 240), i) for i in range(10)),
        (n, [(ts, x, y, 0.8 if i >= 50 else d) for i, (ts, x, y, d) in enumerate(rows)], vessel),
        *(transit(30 + i, "AQM-A", 9.5, (0, 240), 30 + i) for i in range(3)),
    ]
    calibrated(env, fleet, reference(tmp_path / "ref.tif", (0, 240)), monkeypatch)
    assert (
        env.query(
            "SELECT count(*) FROM lake.qc_flags WHERE reason = 'flatline' AND flag = 'unconfirmed'"
        )[0][0]
        > 60
    )
    assert env.query("SELECT count(*) FROM lake.lost_runs") == [(1,)]


@pytest.mark.parametrize("crowd, found", [(3, False), (99, True)])
def test_shoaled_water_isnt_a_lost_bottom(env, tmp_path, monkeypatch, crowd, found):  # noqa: F811
    # Four vessels reading 0.5 m shallow cross a bank that shoaled to 3 m on the far side of
    # a survey that still charts 10 m: each reads 2.5 m there, for 100 soundings. With the
    # crowd as the seabed they read as they should; against the survey alone, each lost it.
    monkeypatch.setattr(calibrate, "CROWD_VESSELS", crowd)
    ref = reference(tmp_path / "ref.tif", (0, 480))
    fleet = []
    for v in range(4):
        for t in range(3):
            n, rows, vessel = transit(1 + 3 * v + t, f"AQM-{v}", 9.5, (0, 480), 3 * v + t)
            rows = [(ts, x, y, d - 7.0 if i >= 140 else d) for i, (ts, x, y, d) in enumerate(rows)]
            fleet.append((n, rows, vessel))
    calibrated(env, fleet, ref, monkeypatch)
    assert (env.query("SELECT count(*) FROM lake.lost_runs")[0][0] > 0) == found


def test_a_bank_crossed_before_the_sounder_sticks_isnt_in_the_run(env, tmp_path, monkeypatch):  # noqa: F811
    # A bank 2.5 m deep, which three vessels sound, on a survey that charts 10 m. T crosses it
    # reading true, then its sounder sticks at the same reading over the 10 m beyond: the
    # readings that make its first steady window read true, and stay out of the run.
    ref = reference(tmp_path / "ref.tif", (0, 240))
    fleet = []
    for v in "ABCT":
        for t in range(3):
            n, rows, vessel = transit(
                10 * "ABCT".index(v) + t + 1, f"AQM-{v}", 9.5, (0, 240), 4 * t + "ABCT".index(v)
            )
            fleet.append(
                (
                    n,
                    [(ts, x, y, 2.0 if i < 30 else d) for i, (ts, x, y, d) in enumerate(rows)],
                    vessel,
                )
            )
    n, rows, vessel = stuck(50, "AQM-T", 2.0, 40)
    fleet.append((n, rows, vessel))
    calibrated(env, fleet, ref, monkeypatch)
    # Its 120 soundings 10 s apart, the first 30 over the bank: the run is the last 90.
    assert env.query(
        "SELECT epoch(t_end - t_start) FROM lake.lost_runs WHERE tile_id IS NOT NULL"
    ) == [(890.0,)]


def test_a_stuck_run_follows_its_soundings_to_a_copy(env, tmp_path, monkeypatch):  # noqa: F811
    fleet = [
        *(transit(1 + i, "AQM-T", 5.4, (0, 240), i) for i in range(10)),
        stuck(20, "AQM-T", 0.8, 20),
        *(transit(30 + i, "AQM-A", 9.5, (0, 240), 30 + i) for i in range(3)),
    ]
    calibrated(env, fleet, reference(tmp_path / "ref.tif", (0, 240)), monkeypatch)
    before = sum(c for u, _, c in corrected(env, "lost_bottom") if u == "AQM-T")
    with open_store(env.store) as con:
        old = con.execute(
            "SELECT file_id FROM lake.files f JOIN lake.lost_runs USING (content_hash)"
        ).fetchone()[0]
        new = con.execute("SELECT max(file_id) + 1 FROM lake.files").fetchone()[0]
        con.execute(
            "INSERT INTO lake.files SELECT * REPLACE ($new AS file_id, key || '.copy' AS key)"
            " FROM lake.files WHERE file_id = $old",
            {"new": new, "old": old},
        )
        con.execute("UPDATE lake.files SET status = 'withdrawn' WHERE file_id = $old", {"old": old})
        ingest.take_over(con, old, new)
    assert (
        before > 60
        and sum(c for u, _, c in corrected(env, "lost_bottom") if u == "AQM-T") == before
    )


def test_stuck_runs_from_another_calibration_arent_current(env, tmp_path, monkeypatch):  # noqa: F811
    calibrated(env, FLEET, reference(tmp_path / "ref.tif", (0, 110)), monkeypatch)
    with open_store(env.store) as con:
        assert calibrate.runs_current(con)
        # As an older build's calibration leaves it.
        con.execute("UPDATE lake.calibration SET offset_m = offset_m + 0.1")
        assert not calibrate.runs_current(con)
    # So `grid cells` waits for `grid calibrate`, rather than build on stale runs.
    with pytest.raises(SystemExit, match="grid calibrate"):
        cli.main(["--store", str(env.store.root), "cells"])


def test_a_recalibration_leaves_changed_tiles_to_rebuild(env, tmp_path, monkeypatch):  # noqa: F811
    calibrated(env, FLEET, reference(tmp_path / "ref.tif", (0, 110)), monkeypatch)
    with open_store(env.store) as con:
        cells.build(con)
        rows = con.execute("SELECT * FROM lake.calibration").fetchall()
        # AQM-A's offset moves well past its standard error.
        moved = [
            (v, seg, s0, s1, o - 1.0 if v == "AQM-A" else o, *rest)
            for v, seg, s0, s1, o, *rest in rows
        ]
        assert calibrate.publish(con, moved, accept_losses=True) > 0
        changed = cells.changed(con)
        cells.build(con, changed)
        cells.done(con, changed)
        # Rebuilding the changed tiles alone makes the cells current for the overlay.
        assert con.execute("SELECT value FROM lake.store_meta WHERE key = 'cells'").fetchone()[
            0
        ] == cells.inputs(con)


def test_a_store_from_before_lost_bottom_marks_no_tiles(env, tmp_path, monkeypatch):  # noqa: F811
    calibrated(env, FLEET, reference(tmp_path / "ref.tif", (0, 110)), monkeypatch)
    with open_store(env.store) as con:
        # As the migration leaves an older store's rows.
        con.execute("UPDATE lake.file_offsets SET lost_bottom = NULL")
        assert calibrate.assign(con) == 0


def test_a_too_deep_segment_publishes_no_shoals(env, tmp_path, monkeypatch):  # noqa: F811
    # A reads 4 m deep, and one of its soundings is a spike shoaler than its track: an
    # unconfirmed shoal, at a depth that is 4 m too deep.
    deep = [transit(1 + i, "AQM-A", 14.0, (0, 240), i) for i in range(3)]
    n, rows, v = deep[0]
    t, lon, lat, _ = rows[20]
    rows = [*rows[:20], (t, lon, lat, 7.0), *rows[21:]]
    fleet = [(n, rows, v), *deep[1:], *FLEET[3:]]
    calibrated(env, fleet, reference(tmp_path / "r.tif", (0, 110)), monkeypatch)
    assert segments(env)[("AQM-A", 0)][1] == "rejected"
    with open_store(env.store) as con:
        cells.build(con)
    assert env.query("SELECT count(*) FROM lake.shoals WHERE abs(lon - ?) < 1e-9", [lon]) == [(0,)]


def test_a_stray_transit_stays_uncalibrated_in_a_copy(env, tmp_path, monkeypatch):  # noqa: F811
    ref = reference(tmp_path / "ref.tif", (0, 240), rows=(4990, 5110))
    tug = [
        *(transit(1 + i, "AQM-T", 10.3, (0, 110), i, r=5100) for i in range(2)),
        *(transit(10 + i, "AQM-T", 5.4, (0, 240), 10 + i) for i in range(10)),
        *(transit(30 + i, "AQM-A", 9.5, (0, 240), 30 + i) for i in range(3)),
    ]
    calibrated(env, tug, ref, monkeypatch)
    [(old,)] = env.query("SELECT min(file_id) FROM lake.calibration_outliers")
    # Ingest moves a withdrawn file's soundings to an identical copy under a new file id.
    with open_store(env.store) as con:
        new = con.execute("SELECT max(file_id) + 1 FROM lake.files").fetchone()[0]
        con.execute(
            "INSERT INTO lake.files SELECT * REPLACE ($new AS file_id, key || '.copy' AS key)"
            " FROM lake.files WHERE file_id = $old",
            {"new": new, "old": old},
        )
        con.execute("UPDATE lake.files SET status = 'withdrawn' WHERE file_id = $old", {"old": old})
        ingest.take_over(con, old, new)
        calibrate.assign(con)
    for u, _, raw, _, ofs, depth in corrected(env):
        if u == "AQM-T" and raw > 10:
            assert ofs is None and depth == raw


def test_a_day_with_a_missing_prediction_is_asked_for_again(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")

    def holed(requests):
        return [
            [[t, None if i == 24 else h] for i, (t, h) in enumerate(s)] for s in levels(requests)
        ]

    later = date(2027, 1, 1)
    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, holed, version="v1", today=later)
        assert con.execute("SELECT count(*) FROM lake.tide_levels").fetchone() == (0,)
        assert tide.build(con, stations, list, residuals, levels, version="v1", today=later) == 1
        assert con.execute("SELECT count(*) FROM lake.tide_levels").fetchone() == (48,)


def test_an_outage_keeps_a_months_observed_levels(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    gauges = [{"id": "g1", "lon": lon + 0.2, "lat": lat + 0.1}]
    soon = date(2026, 10, 20)

    def refused(gauge, month):
        raise OSError("HTTP Error 403: Forbidden")

    with open_store(env.store) as con:
        tide.build(con, stations, lambda: gauges, residuals, levels, version="v1", today=soon)
        tide.build(con, stations, lambda: gauges, refused, levels, version="v1", today=soon)
        assert con.execute("SELECT DISTINCT method FROM lake.tide_levels").fetchall() == [
            ("observed",)
        ]


def test_a_new_cell_that_takes_levels_already_made_marks_its_tile(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    later = date(2027, 1, 1)
    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, levels, version="v1", today=later)
    # The same day, 3 km away: a new tide cell of the same station.
    put(env, 2, [(60, lon + 0.03, lat, 6.0)], "AQM-2")
    env.run("noaa")
    with open_store(env.store) as con:
        cells.build(con)
        assert tide.build(con, stations, list, residuals, levels, version="v1", today=later) == 0
        assert cells.changed(con) == [TILE]


def test_a_failed_fine_raster_keeps_no_coarse_samples(env, tmp_path, monkeypatch):  # noqa: F811
    refs = tmp_path / "refs"
    refs.mkdir()
    reference(refs / "a_coarse.tif", (0, 110), res=16, elevation=-11.0)
    (refs / "b_fine.tif").write_bytes(b"not a raster")
    calibrated(env, FLEET, str(refs), monkeypatch)
    assert env.query("SELECT count(*) FROM lake.reference_pixels") == [(0,)]


def test_a_reference_path_with_no_rasters_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        reference_mod.rasters(str(tmp_path / "unmounted"), (0, 0, 1, 1), {})


def test_a_station_with_no_license_type_is_still_credited(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    unknown = [
        {**s, "license": None, "attribution": "Unlabelled station"} if s["id"] == "far" else s
        for s in stations()
    ]
    with open_store(env.store) as con:
        tide.build(con, lambda: unknown, list, residuals, levels, version="v1")
        assert "Unlabelled station" in overlay.attribution(con)


@pytest.mark.parametrize(
    "status, offset, se, transit, expected, seabed",
    [
        ("rejected", 3.4, 0.3, None, (True, False), 8.0),  # past the bound, however uncertain
        ("rejected", 2.5, 0.6, None, (True, False), 8.0),  # too uncertain to apply, but surely deep
        ("uncalibrated", 0.3, 0.2, None, (False, False), 8.0),  # within noise of zero
        ("uncalibrated", -2.0, 0.2, None, (False, False), 8.0),  # reads shallow: errs safe
        ("anchored", -1.0, 0.05, 2.0, (True, False), 8.0),  # a stray transit measured 2 m deep
        # Stray transits over 8 m of seabed. One reading as a draft would...
        ("anchored", -1.0, 0.05, -2.5, (False, False), 8.0),
        # ...one that lost the bottom: 5 m under its segment, reading 2 m in 8.
        ("anchored", -1.0, 0.05, -6.0, (False, True), 8.0),
        # True among a segment reading 2.6 m deep: shallower than it, but not of the seabed.
        ("anchored", 2.6, 0.05, 0.0, (False, False), 8.0),
        # A sounder moved 3.6 m down, too few transits since to make a step: 4.4 m of 8.
        ("anchored", 0.0, 0.05, -3.6, (False, False), 8.0),
        # A deep draft reading 7 m of 16, its sounder moved 2.5 m: 4.5 m is over half of 7.
        ("anchored", -9.0, 0.05, -11.5, (False, False), 16.0),
        # Calibrated before the seabed was recorded: nothing to judge it by.
        ("anchored", -1.0, 0.05, -6.0, (False, False), None),
    ],
)
def test_files_read_wrong(env, status, offset, se, transit, expected, seabed):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    with open_store(env.store) as con:
        con.execute(
            "INSERT INTO lake.calibration VALUES ('AQM-1', 0, NULL, NULL, ?, ?, ?, 0, 0, 0)",
            [offset, se, status],
        )
        if transit is not None:
            con.execute(
                "INSERT INTO lake.calibration_outliers"
                " SELECT file_id, vessel, ?, ?, content_hash, ? FROM lake.files",
                [transit, offset, seabed],
            )
        calibrate.assign(con)
    [(x, c)] = env.query(
        "SELECT DISTINCT excluded, lost_bottom FROM corrected_points_in("
        "(SELECT any_value(cell_id) FROM lake.points), [], 0, 10800)"
    )
    assert (x, c) == expected


def test_an_empty_refetch_keeps_a_months_residuals(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    gauges = [{"id": "g1", "lon": lon + 0.2, "lat": lat + 0.1}]
    soon = date(2026, 10, 20)
    with open_store(env.store) as con:
        tide.build(con, stations, lambda: gauges, residuals, levels, version="v1", today=soon)
        # CO-OPS answers "No data was found" during an outage.
        tide.build(con, stations, lambda: gauges, lambda g, m: [], levels, version="v1", today=soon)
        assert con.execute("SELECT DISTINCT method FROM lake.tide_levels").fetchall() == [
            ("observed",)
        ]


def test_a_new_engine_that_cant_predict_keeps_the_levels(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")

    def broken(requests):
        return [[] for _ in requests]

    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, levels, version="v1", today=date(2027, 1, 1))
        with pytest.raises(RuntimeError, match="sample days"):
            tide.build(con, stations, list, residuals, broken, version="v2")
        assert con.execute("SELECT count(*) FROM lake.tide_levels").fetchone() == (48,)


def test_a_raster_on_a_datum_never_read_doesnt_hold_its_tile(env, tmp_path, monkeypatch):  # noqa: F811
    refs = tmp_path / "refs"
    refs.mkdir()
    reference(refs / "a_navd88.tif", (0, 110))
    with rasterio.open(
        refs / "b_other.tif",
        "w",
        driver="GTiff",
        width=4,
        height=4,
        count=2,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_bounds(*at(4990, 0, 0, 0), *at(5010, 110, 0, 0), 4, 4),
    ) as d:
        d.write(np.zeros((2, 4, 4), dtype="float32"))
        d.update_tags(VERTICALDATUMWKT='VERTCRS["prvd02"]')
    calibrated(env, FLEET, str(refs), monkeypatch)
    assert env.query("SELECT count(depth) > 0 FROM lake.reference_pixels") == [(True,)]


def test_soundings_awaiting_their_tide_stay_out_of_the_grid(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")

    def blank(requests):
        return [[] for _ in requests]

    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, blank, version="v1", today=date(2027, 1, 1))
        cells.build(con)
    # Its station is in reach but has no level for the day: no cell, rather than a raw depth
    # deeper than chart datum.
    assert env.query("SELECT count(*) FROM lake.cells") == [(0,)]
    [(awaiting,)] = env.query(
        "SELECT awaiting_tide FROM corrected_points_in((SELECT any_value(cell_id) FROM lake.points), [], 0, 10800)"
    )
    assert awaiting


def test_the_overlay_waits_for_tide_to_see_every_area(env, tmp_path):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    with open_store(env.store) as con:
        tide.build(con, stations, list, residuals, levels, version="v1", today=date(2027, 1, 1))
    put(env, 2, [(60, lon + 0.5, lat, 6.0)], "AQM-2")
    env.run("noaa")
    with open_store(env.store) as con:
        cells.build(con)
        with pytest.raises(RuntimeError, match="hasn't seen"):
            overlay.build(con, tmp_path / "out")


def test_a_reference_in_degrees_measures_flatness_in_metres(env, tmp_path, monkeypatch):  # noqa: F811
    w, s = at(4990, 0, 0, 0)
    e, n = at(5010, 220, 0, 0)
    width, height = 800, 80  # cells of about 3 m
    path = tmp_path / "geo.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=2,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_bounds(w, s, e, n, width, height),
        nodata=np.nan,
    ) as d:
        depth = np.full((height, width), -10.0)
        depth[:, -100:] = -30.0  # a trench far east of A's flat survey: relief, if seen
        d.write(np.stack([depth, np.full((height, width), 0.5)]).astype("float32"))
        d.update_tags(VERTICALDATUMWKT='VERTCRS["navd88"]')
    calibrated(env, FLEET, str(path), monkeypatch)
    assert segments(env)[("AQM-A", 0)][1] == "anchored"


def test_a_reference_that_cant_anchor_doesnt_hide_one_that_can(env, tmp_path, monkeypatch):  # noqa: F811
    good = reference(tmp_path / "good.tif", (0, 110))
    steep = tmp_path / "steep"
    steep.mkdir()
    reference(steep / "steep.tif", (0, 110), elevation=-25.0)  # too deep to anchor
    for n, rows, v in FLEET:
        put(env, n, rows, v)
    env.run("noaa")
    monkeypatch.setattr("grid.reference.coops_separation", lambda: lambda lon, lat: 0.0)
    with open_store(env.store) as con:
        untided(con)
        calibrate.run(con, [good, str(steep)])
        # The deep one is as certain; it would win the pixel if picked before the filters.
        con.execute("UPDATE lake.reference_pixels SET uncertainty = 0.1 WHERE depth > 20")
        calibrate.run(con)
    assert segments(env)[("AQM-A", 0)][1] == "anchored"


def test_a_failed_gauge_listing_leaves_the_stations_as_they_were(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    near = {
        "id": "near",
        "lon": lon + 0.05,
        "lat": lat,
        "commercial_use": True,
        "accepted": True,
        "has_datums": True,
        "chart_datum": "MLLW",
    }

    def down():
        raise RuntimeError("CO-OPS listed only 0 water level gauges")

    with open_store(env.store) as con:
        tide.build(con, lambda: [*stations(), near], list, residuals, levels, version="v1")
        before = con.execute("SELECT count(*) FROM lake.tide_levels").fetchone()
        with pytest.raises(RuntimeError, match="listed only"):
            tide.build(con, stations, down, residuals, levels, version="v2")
        assert con.execute(
            "SELECT count(*) FROM lake.tide_stations WHERE station = 'near'"
        ).fetchone() == (1,)
        assert con.execute("SELECT count(*) FROM lake.tide_levels").fetchone() == before


def test_a_station_moves_to_a_nearer_gauge_when_one_is_listed(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    far = [{"id": "g1", "lon": lon + 0.9, "lat": lat}]
    later = date(2027, 1, 1)
    with open_store(env.store) as con:
        tide.build(con, stations, lambda: far, residuals, levels, version="v1", today=later)
        cells.build(con)
        nearer = [*far, {"id": "g2", "lon": lon + 0.2, "lat": lat}]
        tide.build(con, stations, lambda: nearer, residuals, levels, version="v1", today=later)
        [(gauge,)] = con.execute(
            "SELECT gauge FROM lake.tide_stations WHERE station = 'far'"
        ).fetchall()
        assert gauge == "g2"
        assert con.execute("SELECT count(*) FROM lake.tide_levels").fetchone() == (48,)
        assert cells.changed(con) == [TILE]


def test_a_station_the_engine_cant_predict_hands_its_cells_on(env):  # noqa: F811
    lon, lat = at(5000, 0)
    day = 86400
    put(env, 1, [(0, lon, lat, 5.0), (day, lon, lat, 5.1), (-day, lon, lat, 5.2)])
    env.run("noaa")
    near = {
        "id": "near",
        "lon": lon + 0.05,
        "lat": lat,
        "commercial_use": True,
        "accepted": True,
        "has_datums": True,
        "chart_datum": "MLLW",
    }

    def only_far(requests):
        return [s if r["station"] == "far" else [] for r, s in zip(requests, levels(requests))]

    later = date(2027, 1, 1)
    with open_store(env.store) as con:
        tide.build(
            con, lambda: [*stations(), near], list, residuals, only_far, version="v1", today=later
        )
        assert con.execute(
            "SELECT unpredictable FROM lake.tide_stations WHERE station = 'near'"
        ).fetchone() == (True,)
        tide.build(
            con, lambda: [*stations(), near], list, residuals, only_far, version="v1", today=later
        )
    [(station,)] = env.query(
        "SELECT s.station FROM lake.tide_cells JOIN lake.tide_stations s USING (station_id)"
    )
    assert station == "far"
    assert all(h is not None for *_, h, _, _ in corrected(env))


def test_a_gauge_missing_from_a_short_listing_keeps_its_stations(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    both = [{"id": "g1", "lon": lon + 0.2, "lat": lat}, {"id": "g2", "lon": lon + 0.6, "lat": lat}]
    later = date(2027, 1, 1)
    with open_store(env.store) as con:
        tide.build(con, stations, lambda: both, residuals, levels, version="v1", today=later)
        tide.build(con, stations, lambda: both[1:], residuals, levels, version="v1", today=later)
        assert con.execute(
            "SELECT gauge FROM lake.tide_stations WHERE station = 'far'"
        ).fetchone() == ("g1",)


def test_a_past_months_first_empty_answer_leaves_it_open(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 5.0)])
    env.run("noaa")
    gauges = [{"id": "g1", "lon": lon + 0.2, "lat": lat}]
    later = date(2027, 1, 1)
    with open_store(env.store) as con:
        tide.build(
            con, stations, lambda: gauges, lambda g, m: [], levels, version="v1", today=later
        )
        tide.build(con, stations, lambda: gauges, residuals, levels, version="v1", today=later)
        assert con.execute("SELECT DISTINCT method FROM lake.tide_levels").fetchall() == [
            ("observed",)
        ]
