import math
import random
import statistics
import struct
from datetime import date, datetime, timedelta

import duckdb
import pytest
import reference_qc
from test_ingest import HEADER, VESSEL, env, geojson, ow_key  # noqa: F401  (env is a fixture)

from grid import catalog, cells, ingest, qc, statistic
from grid.catalog import open_store


def float32(x):
    return struct.unpack("f", struct.pack("f", x))[0]


LAT0, LON0 = 33, -78  # k = 1 here, so base cells are 1/10800° square
T0 = datetime(2026, 10, 13, 18, 0, 0)


def at(r, c, fr=0.5, fc=0.5):
    """Lon, lat inside base cell (r, c) of the tile at (LAT0, LON0)."""
    return LON0 + (c + fc) / cells.BASE, LAT0 + (r + fr) / cells.BASE


def csv(rows, unique_id="AQM-1"):
    """rows: (seconds after T0, lon, lat, depth)"""
    lines = [
        f"{unique_id},f,{lon!r},{lat!r},{d},{(T0 + timedelta(seconds=s)).isoformat()}Z,A,AquaMap\n"
        for s, lon, lat, d in rows
    ]
    return (HEADER + "".join(lines)).encode()


def put(env, n, rows, unique_id="AQM-1"):  # noqa: F811
    key = f"csb/csv/2026/10/14/20261014{n:06d}000000_{n}_pointData.csv"
    env.noaa.put(key, csv(rows, unique_id))


def build(env):  # noqa: F811
    env.run("noaa")  # QC runs on each batch as it's ingested
    with open_store(env.store) as con:
        cells.build(con)


def flags(env):  # noqa: F811
    return sorted(
        (flag, reason, d)
        for flag, reason, d in env.query(
            f"""SELECT q.flag, q.reason, p.depth_raw FROM lake.qc_flags q
            JOIN lake.points p ON q.point_id = {catalog.POINT_ID}"""
        )
    )


def grid(env):  # noqa: F811
    return env.query(
        """SELECT level, "row", col, depth, median, count, vessels, kind, first, last
        FROM lake.cells ORDER BY level, "row", col"""
    )


# Every correction's σ when none applies: no tide, no calibration.
CSIG = math.hypot(catalog.UNTIDED_SIGMA, catalog.UNCALIBRATED_SIGMA)


def sigma(env):  # noqa: F811
    return env.query('SELECT level, "row", col, sigma FROM lake.cells ORDER BY level, "row", col')


def line(depths, start=0, step=10, r=5000):
    """One sounding every `step` seconds along a row, a base cell apart (about 1 kn)."""
    return [(start + i * step, *at(r, i), d) for i, d in enumerate(depths)]


# QC


def test_sentinels_time_and_shallow(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, 0), (1, lon, lat, -1e9), (2, lon, lat, 12000), (3, lon, lat, 0.3)])
    late = (datetime(2026, 10, 16) - T0).total_seconds()
    early = (datetime(1999, 6, 1) - T0).total_seconds()
    put(env, 2, [(late, lon, lat, 5), (early, lon, lat, 5)], "AQM-2")
    build(env)
    assert flags(env) == [
        ("reject", "sentinel", -1e9),
        ("reject", "sentinel", 0),
        ("reject", "sentinel", 12000),
        ("reject", "time", 5),
        ("reject", "time", 5),
        ("review", "very_shallow", 0.30000001192092896),
    ]


def test_position_jump_rejects_only_the_jumping_point(env):  # noqa: F811
    rows = line([10] * 9)
    s, lon, lat, d = rows[4]
    rows[4] = (s, lon + 0.01, lat, d)  # about 1 km off the line, 10 s from its neighbors
    put(env, 1, rows)
    build(env)
    assert [(f, r) for f, r, _ in flags(env)] == [("reject", "jump")]


def test_fast_ships_are_not_jumps(env):  # noqa: F811
    # About 25 kn: 13 base cells (130 m) every 10 s.
    rows = [(i * 10, *at(5000, i * 13), 30) for i in range(9)]
    put(env, 1, rows)
    build(env)
    assert flags(env) == []


def test_spikes_are_one_sided(env):  # noqa: F811
    put(env, 1, line([10, 10, 10, 20, 10, 10, 3, 10, 10, 10]))
    build(env)
    assert flags(env) == [("reject", "spike", 20), ("unconfirmed", "spike", 3)]


def test_transits_split_at_long_gaps(env):  # noqa: F811
    shallow = line([10] * 6)
    deep = line([50] * 6, start=5 * 3600, r=5100)  # 5 hours later
    put(env, 1, shallow + deep)
    build(env)
    assert flags(env) == []


# Cells


def test_k_keeps_cells_roughly_square():
    assert [cells.k_for(lat) for lat in (0, 33, 60, 75, 89)] == [1, 1, 2, 4, 120]
    assert all(cells.STEPS % cells.k_for(lat) == 0 for lat in range(-90, 90))


def test_levels_follow_vessel_counts(env):  # noqa: F811
    # Two vessels in one 1″ cell: base cells. One vessel alone: a 3″ cell.
    put(env, 1, [(0, *at(4998, 0), 10)], "A")
    put(env, 2, [(0, *at(4999, 1), 11)], "B")
    put(env, 3, [(0, *at(6000, 0), 12)], "C")
    # One vessel in its 1″ cell, another elsewhere in the 3″ cell: a 1″ cell.
    put(env, 4, [(0, *at(7000, 0), 13)], "D")
    put(env, 5, [(0, *at(7001, 5), 14)], "E")
    build(env)
    got = {(lv, r, c) for lv, r, c, *_ in grid(env)}
    assert got == {
        (1, 4998, 0),
        (1, 4999, 1),
        (9, 6000 // 9, 0),
        (3, 7000 // 3, 0),
        (3, 7001 // 3, 1),
    }


def test_depth_is_the_median_of_vessels_less_k_sigma(env):  # noqa: F811
    depths = [6 + (i * 7 % 20) / 10 for i in range(20)]  # 6.0 to 7.9, shuffled
    for i, d in enumerate(depths):
        # One sounding per vessel, so no track spike tests apply.
        put(env, i + 1, [(i, *at(5000, 0, 0.02 + i * 0.045, 0.5), d)], f"V{i}")
    build(env)
    [(level, _, _, depth, _, count, vessels, kind, first, last)] = grid(env)
    assert (level, count, vessels, kind) == (1, 20, 20, "multi")
    # One pixel: too few pixels for a plane, so the spread is around the median.
    m = statistics.median(float32(d) for d in depths)
    spread = 1.4826 * statistics.median(abs(float32(d) - m) for d in depths)
    want_sigma = math.hypot(spread, CSIG)
    [(*_, got_sigma)] = sigma(env)
    assert got_sigma == pytest.approx(want_sigma, abs=1e-5)
    assert depth == pytest.approx(m - statistic.K * want_sigma, abs=1e-5)
    assert (first, last) == (date(2026, 10, 1), date(2026, 10, 1))


def test_the_margin_alone_never_makes_water_drying(env):  # noqa: F811
    # One uncorrected vessel at 1.5 m: 1.5 m less K σ would be about -0.5 m, drying.
    put(env, 1, [(0, *at(5000, 0), 1.5)])
    build(env)
    [row] = grid(env)
    assert 1.5 - statistic.K * CSIG < 0 and row[3] == 0


def test_smoothing_never_takes_a_narrow_shoal_out_of_the_soundings(env):  # noqa: F811
    # Six vessels cross a bar one pixel (two base columns) wide at 5 m in 9 m water, four
    # soundings to a base cell, so the bar is no track spike. Along each track the bar is
    # one vote among its neighbours' 9s, but the cell on it is never deeper than its own
    # vessels' median less K σ.
    for i in range(6):
        rows = [(i * 1000 + 3 * (4 * c + j), *at(5000, c, 0.1 + 0.15 * i, 0.1 + 0.25 * j),
                 5.0 if c in (30, 31) else 9.0) for c in range(60) for j in range(4)]  # fmt: skip
        put(env, i + 1, rows, f"V{i}")
    build(env)
    bar = [row for row in grid(env) if row[:2] == (1, 5000) and row[2] in (30, 31)]
    assert len(bar) == 2 and all(row[3] <= 5.0 for row in bar)
    assert all(row[3] > 6 for row in grid(env) if row[2] not in (30, 31))


def test_a_vessel_logging_at_1_hz_counts_once(env):  # noqa: F811
    # A logs 100 soundings at 9 m in one base cell; B and C read 9.8 and 9.9 m. By
    # soundings the cell is 9 m; by vessels it's 9.8.
    put(env, 1, [(i, *at(5000, 0, 0.1 + i * 0.008), 9.0) for i in range(100)], "A")
    put(env, 2, [(200, *at(5000, 0, 0.5), 9.8)], "B")
    put(env, 3, [(201, *at(5000, 0, 0.6), 9.9)], "C")
    build(env)
    [(_, _, _, depth, median, count, vessels, *_)] = grid(env)
    assert (count, vessels, median) == (102, 3, 9.0)
    want_sigma = math.hypot(1.4826 * 0.1, CSIG)
    assert depth == pytest.approx(9.8 - statistic.K * want_sigma, abs=1e-5)


def test_single_vessel_dates_are_years(env):  # noqa: F811
    put(env, 1, [(0, *at(5000, 0), 10)])
    build(env)
    [(*_, kind, first, last)] = grid(env)
    assert (kind, first, last) == ("single", date(2026, 1, 1), date(2026, 1, 1))


def test_cell_outliers_are_one_sided_and_shoals_can_be_confirmed(env):  # noqa: F811
    # Two vessels, so there's no consensus of other vessels and the cell judges alone.
    soundings = [10.0, 10.2, 9.9, 10.1, 10.0, 30.0, 2.0]
    for i, d in enumerate(soundings):
        put(env, i + 1, [(i, *at(5000, 0, 0.1 + i * 0.1), d)], "V0" if i < 5 else "V1")
    build(env)
    assert flags(env) == [("reject", "cell_deep", 30), ("unconfirmed", "cell_shoal", 2)]
    # One vessel left, alone in the tile: no spread, only the corrections' σ.
    assert grid(env)[0][3] == pytest.approx(10.0 - statistic.K * CSIG, abs=1e-5)

    # A second vessel sounding the shoal within its tolerance confirms it.
    put(env, 9, [(20, *at(5000, 0, 0.9), 2.5)], "V9")
    build(env)
    # Two other vessels now vote on the 30 m sounding, and it's far deeper than both; the
    # two shoals confirm each other.
    assert flags(env) == [
        ("confirmed", "cell_shoal", 2.0),
        ("confirmed", "cell_shoal", 2.5),
        ("reject", "consensus_deep", 30),
    ]
    # Two of three vessels now read the shoal, so the median less K σ is shoaler still.
    assert grid(env)[0][3] <= 2.0 and ("confirmed", "cell_shoal", 2.0) in flags(env)


def test_track_shoal_spike_confirmed_by_another_vessel(env):  # noqa: F811
    put(env, 1, line([10, 10, 10, 10, 3, 10, 10, 10, 10]))
    put(env, 2, [(100, *at(5000, 4, 0.2), 3.4)], "AQM-2")
    build(env)
    assert ("confirmed", "cell_confirmed", 3) in flags(env)


def test_readings_under_half_a_metre_dont_confirm_each_other(env):  # noqa: F811
    # Two vessels' junk 0.3 m readings in one cell of a 14 m channel: as a 3 m shoal they
    # would confirm each other, as readings under 0.5 m they stay unconfirmed and out of
    # the cell's depth.
    put(env, 1, line([14, 14, 14, 14, 0.3, 14, 14, 14, 14]))
    put(env, 2, line([14, 14, 14, 14, 0.3, 14, 14, 14, 14], start=100), "AQM-2")
    build(env)
    assert not [f for f in flags(env) if f[0] == "confirmed"]
    assert ("unconfirmed", "spike", float32(0.3)) in flags(env)
    assert all(row[4] == 14 for row in grid(env))


def test_a_half_metre_track_spike_never_sets_a_cells_depth(env):  # noqa: F811
    # A's 0.3 m spike lands among B's ordinary 0.3 m readings, which agree with it: it
    # still can't be confirmed, so it stays an unconfirmed shoal, out of the cell's depth.
    put(env, 1, line([4, 4, 4, 4, 0.3, 4, 4, 4, 4]))
    put(env, 2, apart([(0, *at(5000, 4, 0.3 + 0.1 * i), 0.3) for i in range(5)]), "AQM-2")
    build(env)
    assert ("unconfirmed", "spike", float32(0.3)) in flags(env)
    assert not [f for f in flags(env) if f[0] == "confirmed"]
    [count] = [row[5] for row in grid(env) if row[:3] == (1, 5000, 4)]
    assert count == 5  # B's five, not A's spike


def test_a_sounder_that_loses_bottom_is_steep(env):  # noqa: F811
    # FARSND in the Chesapeake: 20 m, then 370-716 m within a minute, then 20 m again.
    put(env, 1, line([20.0] * 10 + [370.0 + 13.3 * i for i in range(26)] + [20.0] * 10, step=2))
    env.run("noaa")
    assert {(f, r) for f, r, _ in flags(env)} == {("reject", "steep")}
    assert len(flags(env)) == 26


def test_one_other_vessel_is_enough_to_reject_a_far_deeper_sounding(env):  # noqa: F811
    # Vessel A's 20 m in two places 45 base cells (about 400 m) apart, each with one other
    # vessel beside it: one lost bottom there, the other crossed a real hole.
    a = [(0, *at(5000, c, 0.1 + 0.1 * i), 20.0) for c in (0, 45) for i in range(5)]
    put(env, 1, apart(a))
    put(env, 2, apart([(0, *at(5000, 1, 0.5), 400.0)]), "LOST")
    put(env, 3, apart([(0, *at(5000, 46, 0.5), 35.0)]), "HOLE")  # deeper, but not far
    build(env)
    assert flags(env) == [("reject", "consensus_far_deep", 400)]


def test_a_vessel_reading_junk_near_the_surface_cant_make_real_water_far_deep(env):  # noqa: F811
    put(env, 1, apart([(0, *at(5000, 0, 0.1 + 0.1 * i), 1.0) for i in range(5)]), "JUNK")
    put(env, 2, apart([(0, *at(5000, 1, 0.5), 15.0)]), "REAL")
    build(env)
    assert not [f for f in flags(env) if f[1] == "consensus_far_deep"]


def test_a_noisy_track_votes_but_sets_no_depth(env):  # noqa: F811
    # A sounder hunting between 6 and 13 m, as NOAA Ship Pisces' did, crossing B's 9 m.
    # Its 13 m side is noise and its 6 m side unconfirmed shoals that can't confirm each
    # other: neither sets a depth, so B's 9 m does.
    put(env, 1, line([6, 13] * 15, step=2), "PISCES")
    put(env, 2, apart([(0, *at(5000, 4, 0.5), 9.0)]), "B")
    build(env)
    assert {(f, r, d) for f, r, d in flags(env) if r in ("track_noise", "spike")} == {
        ("noisy", "track_noise", 13),
        ("unconfirmed", "track_noise", 6),
    }
    assert [row[4] for row in grid(env) if row[2] < 5 or row[0] > 1] == [9.0]


def test_a_noisy_track_doesnt_corroborate_another_vessels_shoal(env):  # noqa: F811
    # Three vessels agree on 20 m; A reads 12 m once; B hunts between 12 and 15 m in the
    # same block. B's 12 m readings are noise, so they don't save A's from being disproved.
    for n, v in enumerate(("V1", "V2", "V3"), 1):
        put(env, n, apart([(0, *at(5000, 2 + n, 0.5), 20.0)]), v)
    put(env, 4, apart([(0, *at(5000, 4, 0.2), 12.0)]), "A")
    put(env, 5, line([12, 15] * 8, step=2, r=5001), "B")
    build(env)
    assert ("noisy", "track_noise", 12) in flags(env)
    assert ("unconfirmed", "consensus_shoal", 12) in [
        f for f in flags(env) if f[1] == "consensus_shoal"
    ]


def test_a_rock_on_a_noisy_track_stays_a_shoal(env):  # noqa: F811
    # A hunting sounder crosses a 2 m rock: it's kept as an unconfirmed shoal and published,
    # not lost as noise.
    depths = [9, 13] * 10
    depths[10] = 2
    put(env, 1, line(depths, step=2), "HUNTER")
    build(env)
    assert ("unconfirmed", "track_noise", 2) in flags(env)
    assert 2.0 in [row[4] for row in env.query("SELECT * FROM lake.shoals")]


def test_two_vessels_shoal_readings_confirm_each_other(env):  # noqa: F811
    put(env, 1, line([14, 14, 14, 14, 3, 14, 14, 14, 14]))
    put(env, 2, line([14, 14, 14, 14, 3, 14, 14, 14, 14], start=100), "AQM-2")
    build(env)
    assert [f for f in flags(env) if f[0] == "confirmed"] == [("confirmed", "cell_shoal", 3)] * 2


def test_cells_keep_the_shoals_still_unconfirmed(env):  # noqa: F811
    # A's 20 m spike is rejected and its 3 m one stays unconfirmed; B's 3 m spike is
    # confirmed by C reading 3.4 m beside it.
    put(env, 1, line([10, 10, 10, 20, 10, 10, 3, 10, 10, 10]))
    put(env, 2, line([10, 10, 10, 10, 3, 10, 10, 10, 10], r=6000), "B")
    put(env, 3, [(100, *at(6000, 4, 0.2), 3.4)], "C")
    build(env)
    assert ("confirmed", "cell_confirmed", 3) in flags(env)
    shoals = env.query('SELECT tile_id, "row", lon, lat, depth FROM lake.shoals')
    assert shoals == [((LAT0 + 90) * 360 + LON0 + 180, 5000, *at(5000, 6), 3.0)]


@pytest.mark.parametrize("judged, reason", [(True, "cell_shoal"), (False, "cell_unjudged")])
def test_a_cell_shoal_is_unjudged_without_a_median_to_judge_it(judged, reason):
    con = duckdb.connect()
    con.execute(
        """CREATE TABLE classed AS SELECT 1 AS point_id, 'shoal' AS outlier,
        false AS from_track, ? AS judged, 5.0 AS raw, false AS hunting""",
        [judged],
    )
    con.execute("CREATE TABLE confirmed (point_id INTEGER)")
    con.execute("CREATE TABLE consensus_rejects (point_id INTEGER, flag VARCHAR, reason VARCHAR)")
    assert con.execute(cells.CELL_FLAGS).fetchall() == [(1, "unconfirmed", reason)]


def test_shoals_are_the_soundings_nothing_confirmed_or_rejected():
    con = duckdb.connect()
    con.execute("ATTACH ':memory:' AS lake")
    con.execute(
        """CREATE TABLE lake.qc_flags (
          point_id BIGINT, flag VARCHAR, reason VARCHAR, qc_version INTEGER, cell_id SMALLINT,
          tile_id INTEGER)"""
    )
    tile = (LAT0 + 90) * 360 + LON0 + 180
    con.execute(
        "CREATE TABLE tile_points AS SELECT unnest(range(1, 9)) AS point_id, ? AS tile_id,"
        " 5000 AS r, ? AS lon, ? AS lat, 3.0::DOUBLE AS depth_raw, 3.0::DOUBLE AS depth, false AS excluded,"
        " point_id IN (5, 6, 7, 8) AS lost_bottom, false AS awaiting_tide",
        [tile, *at(5000, 7)],
    )
    v = qc.QC_VERSION
    con.executemany(
        "INSERT INTO lake.qc_flags VALUES (?, ?, ?, ?, 1, ?)",
        [
            (*flag, tile)
            for flag in [
                (1, "unconfirmed", "spike", v),  # still a shoal
                (2, "unconfirmed", "spike", v),
                (2, "confirmed", "cell_confirmed", v),
                (3, "unconfirmed", "spike", v),
                (3, "reject", "consensus_shoal", v),
                (4, "unconfirmed", "spike", v - 1),  # an older QC's
                # 5: a sounding of a transit that lost the bottom, a shoal with no flag of its own
                (6, "reject", "spike", v),  # lost the bottom, but rejected anyway
            ]
        ],
    )
    # 7: lost the bottom, but reading deeper than HAZARD_M: no hazard to warn of.
    con.execute("UPDATE tile_points SET depth = ? WHERE point_id = 7", [qc.HAZARD_M + 5.0])
    # 8: lost the bottom, reading under SHALLOW_M: a sounder's junk, no hazard either.
    con.execute("UPDATE tile_points SET depth_raw = 0.3, depth = 0.3 WHERE point_id = 8")
    con.execute(cells.SHOALS, {"partition": 1, "tiles": [tile]})
    assert con.execute("SELECT tile_id, r, c FROM shoals").fetchall() == [(tile, 5000, 7)] * 2


def test_aggregated_cells_keep_their_shoalest_base_cell(env):  # noqa: F811
    # One vessel, so the 3″ cell is published. One base cell holds a single 12 m
    # sounding among 49 at 14 to 20 m elsewhere: the 3″ cell keeps that base cell's
    # depth, 12 m less K σ, and its σ. Soundings are five hours apart, each its own
    # transit, so the track spike test leaves them alone.
    rows = [(-i * 5 * 3600, *at(4995 + i % 8, i // 8), 14 + (i * 13 % 49) / 8) for i in range(49)]
    rows.append((-50 * 5 * 3600, *at(5003, 8), 12.0))
    put(env, 1, rows)
    build(env)
    [(level, *_, depth, _median, count, _vessels, _kind, _first, _last)] = grid(env)
    [(*_, got_sigma)] = sigma(env)
    assert (level, count) == (9, 50)
    # One vessel ranging 14 to 20 m pixel to pixel: σ is wide, and the margin alone
    # stops at 0 m rather than draw the water drying.
    assert depth == pytest.approx(max(12.0 - statistic.K * got_sigma, 0), abs=1e-5)


def apart(rows):
    """Space soundings five hours apart, each its own transit, so track QC leaves them alone."""
    return [(-i * 5 * 3600, lon, lat, d) for i, (_, lon, lat, d) in enumerate(rows)]


def test_cells_never_trust_that_qc_ran(env):  # noqa: F811
    lon, lat = at(5000, 0)
    put(env, 1, [(0, lon, lat, -1e9), (1, lon, lat, 10), (2, lon, lat, 0)])
    env.run("noaa")
    with open_store(env.store) as con:
        con.execute("DELETE FROM lake.qc_flags")  # as if QC never ran
        cells.build(con)
    assert [row[3] for row in grid(env)] == [pytest.approx(10 - statistic.K * CSIG, abs=1e-5)]


def test_a_feature_one_track_crosses_is_not_noise(env):  # noqa: F811
    # A channel edge inside one single-vessel 3″ cell: 21 soundings at 12 m, 9 at 3 m.
    rows = [(0, *at(4995 + i % 3, i // 3), 12.0) for i in range(21)]
    rows += [(0, *at(4998 + i % 3, i // 3), 3.0) for i in range(9)]
    put(env, 1, apart(rows))
    build(env)
    [row] = grid(env)
    assert (row[0], row[5]) == (9, 30)  # level, count
    # The 3 m soundings confirm each other: shoals, flagged so the surface holds them.
    assert row[3] <= 3.0 and flags(env) == [("confirmed", "cell_shoal", 3.0)] * 9


def test_levels_count_only_vessels_with_accepted_soundings(env):  # noqa: F811
    rows = [(0, *at(5000, 0, 0.1 + i * 0.1), 10.0) for i in range(5)]
    rows += [(0, *at(5000, 1), 10.0), (0, *at(5000, 2), 10.0)]
    put(env, 1, apart(rows))
    put(env, 2, [(0, *at(5000, 0, 0.9), 60.0)], "B")  # rejected: far deeper than A's 10 m
    build(env)
    assert [row[:3] for row in grid(env)] == [(9, 5000 // 9, 0)]
    assert ("reject", "consensus_far_deep", 60) in flags(env)


@pytest.mark.parametrize("shoal, kept", [(8.0, True), (2.0, False)])
def test_a_confirmed_shoal_stands_only_near_the_other_vessels(env, shoal, kept):  # noqa: F811
    # 30 vessels read 10 m; two others read a shoal and confirm each other. Within 2 m + 5%
    # of the others' 10 m it sets the depth; far shoaler, it's an echo they outvote.
    for i in range(30):
        put(env, i + 1, [(i, *at(5000, 0, 0.02 + i * 0.03), 10.0)], f"V{i}")
    put(env, 31, [(40, *at(5000, 0, 0.95), shoal)], "R1")
    put(env, 32, [(41, *at(5000, 0, 0.97), shoal + 0.3)], "R2")
    build(env)
    [row] = grid(env)
    got = flags(env)
    if kept:
        # However many deeper soundings surround it, it sets the depth.
        assert row[3] == pytest.approx(shoal) and ("confirmed", "cell_shoal", shoal) in got
        [(lon, lat)] = env.query("SELECT depth_lon, depth_lat FROM lake.cells")
        assert (lon, lat) == at(5000, 0, 0.95)
    else:
        assert ("unconfirmed", "consensus_shoal", shoal) in got
        assert ("confirmed", "cell_shoal", shoal) not in got and row[3] > 7
        assert (shoal,) in env.query("SELECT depth FROM lake.shoals")


def test_each_other_vessel_votes_once_around_a_shoal():
    # R's confirmed 2 m shoal shares its pixel with A only, so the pixels around it judge.
    # A read 10 m across three of them and B 2.2 m in one: each votes once, half of them
    # read the shoal, and it stands.
    rows = [(1, 10, 10, "R", 2.0, "shoal")]
    rows += [
        (2 + i, r, c, "A", 10.0, None)
        for i, (r, c) in enumerate(((10, 11), (12, 10), (12, 12), (10, 12)))
    ]
    rows.append((9, 8, 10, "B", 2.2, None))
    con = duckdb.connect()
    con.execute(
        """CREATE TABLE group_accepted (point_id INTEGER, r INTEGER, c INTEGER, vessel VARCHAR,
        d DOUBLE, outlier VARCHAR, tile_id INTEGER DEFAULT 1, content_key UBIGINT DEFAULT 0)"""
    )
    con.executemany(
        "INSERT INTO group_accepted (point_id, r, c, vessel, d, outlier) VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    con.execute(cells.OUTVOTED)
    assert con.execute("SELECT * FROM outvoted").fetchall() == []
    # With B reading 10 m too, both other vessels are deeper by far, and it's outvoted.
    con.execute("UPDATE group_accepted SET d = 10.0, vessel = 'C' WHERE vessel = 'B'")
    con.execute(cells.OUTVOTED)
    assert con.execute("SELECT point_id FROM outvoted").fetchall() == [(1,)]


def test_a_confirmed_shoal_too_few_others_can_judge_stands(env):  # noqa: F811
    # One other vessel reads 10 m; R reads 2 m on two passes five hours apart, which
    # confirm each other. One vessel is too few to outvote it.
    put(env, 1, [(i, *at(5000, 0, 0.1 + i * 0.1), 10.0) for i in range(5)], "V")
    put(env, 2, [(0, *at(5000, 0, 0.8), 2.0), (5 * 3600, *at(5000, 0, 0.9), 2.2)], "R")
    build(env)
    assert ("confirmed", "cell_shoal", 2.0) in flags(env)
    assert grid(env)[0][3] == pytest.approx(2.0)


def test_units_group_small_tiles_and_band_dense_ones(env, monkeypatch):  # noqa: F811
    put(env, 1, [(0, *at(5000, 0), 10)])
    env.noaa.put(
        "csb/csv/2026/10/14/20261014000059000000_99_pointData.csv",
        csv([(0, LON0 + 1.5, LAT0 + 0.5, 12)], "B"),
    )
    env.run("noaa")
    with open_store(env.store, write=False) as con:
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.points").fetchall()
        assert [len(t) for t, _, _ in cells.units(con, partition, [])] == [2]
        monkeypatch.setattr(cells, "BATCH_POINTS", 1)
        assert [len(t) for t, _, _ in cells.units(con, partition, [])] == [1, 1]


def test_bands_build_the_same_cells_as_whole_tiles(env, monkeypatch):  # noqa: F811
    # Two tracks crossing several 3″ rows, with holes along them and across band edges.
    put(env, 1, apart([(0, *at(4990 + i, 3 + i % 2 * 2), 10 + i % 3) for i in range(40)]))
    put(env, 2, apart([(0, *at(4990 + i, 4), 11) for i in range(0, 40, 2)]), "B")
    put(env, 3, line([10, 10, 10, 3, 10, 10, 10], r=4999), "C")  # a shoal on a band edge
    build(env)
    whole = grid(env)
    shoals = env.query("SELECT * FROM lake.shoals")
    assert shoals
    monkeypatch.setattr(cells, "BATCH_POINTS", 5)
    with open_store(env.store) as con:
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.points").fetchall()
        assert len(cells.units(con, partition, [])) > 2
        assert cells.build(con)["kept"] == 0  # a finished build is rebuilt, not kept
    assert grid(env) == whole and env.query("SELECT * FROM lake.shoals") == shoals


def test_a_lone_ping_shoaler_than_its_cell_stays_unconfirmed(env):  # noqa: F811
    # Within 2 m + 5% of the cell's soundings, but it stands out from them, and
    # nothing else that stands out agrees with it.
    for i in range(20):
        put(env, i + 1, [(i, *at(5000, 0, 0.02 + i * 0.045), 10.0)], f"V{i}")
    put(env, 21, [(30, *at(5000, 0, 0.97), 8.5)], "X")
    build(env)
    assert flags(env) == [("unconfirmed", "cell_shoal", 8.5)]
    assert grid(env)[0][3] == pytest.approx(10.0 - statistic.K * CSIG, abs=1e-5)


def test_ingest_qcs_each_batch_and_reruns_match(env):  # noqa: F811
    put(env, 1, line([10, 10, 10, 20, 10, 10, 3, 10, 10, 10]))
    env.run("noaa")
    first = flags(env)
    assert first == [("reject", "spike", 20), ("unconfirmed", "spike", 3)]
    with open_store(env.store) as con:
        assert qc.run(con, missing_only=True) == 0
        assert qc.run(con) == 1
    assert flags(env) == first


def test_a_track_spike_deeper_than_its_cell_is_rejected(env):  # noqa: F811
    # A's 10 m reading is shoaler than A's 20 m track (a track spike), but deeper than
    # B's 5 m cell: it must not count A as a second vessel there.
    put(env, 1, line([20, 20, 20, 20, 10, 20, 20, 20, 20]))
    put(env, 2, apart([(0, *at(5000, 4, 0.1 + i * 0.15), 5.0) for i in range(5)]), "B")
    build(env)
    assert ("reject", "cell_deep", 10) in flags(env)
    # A's 20 m soundings beside it keep the 1″ cell at base level, but base cell
    # (5000, 4) holds only B's soundings.
    assert [row[6:8] for row in grid(env) if row[:3] == (1, 5000, 4)] == [(1, "single")]


def test_a_band_reads_only_its_rows(env):  # noqa: F811
    put(env, 1, apart([(0, *at(r, 0), 10) for r in (100, 5000, 9000)]))
    env.run("noaa")
    with open_store(env.store, write=False) as con:
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.points").fetchall()
        rows = con.execute(
            "SELECT count(*) FROM active_points_in($p, [], 4995, 5004)", {"p": partition}
        ).fetchone()
    assert rows == (1,)


def test_sampled_cells_still_publish_at_an_actual_sounding(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(cells, "CELL_SAMPLE", 4)
    depths = [10 + (i * 7 % 40) / 10 for i in range(40)]
    rows = [(0, *at(5000, 0, 0.01 + i * 0.024), d) for i, d in enumerate(depths)]
    put(env, 1, apart(rows))
    build(env)
    [row] = grid(env)
    depth, median, count = row[3], row[4], row[5]
    assert count == 40 and depth < median
    [at_] = env.query("SELECT depth_lon, depth_lat FROM lake.cells")
    assert at_ in [(lon, lat) for _, lon, lat, _ in rows]


def put_dated(env, n, rows, unique_id, day="2026/10/22"):  # noqa: F811
    """Like put, under a later folder date, so a week of soundings isn't after arrival."""
    key = f"csb/csv/{day}/{day.replace('/', '')}{n:06d}000000_{n}_pointData.csv"
    env.noaa.put(key, csv(rows, unique_id))


@pytest.fixture
def sql_rules(monkeypatch):
    """Only the rules the reference SQL has: no steep or noise checks."""
    monkeypatch.setattr(qc, "STEEP_FACTOR", math.inf)
    monkeypatch.setattr(qc, "NOISE_REL", math.inf)


def qc_both_ways(env):  # noqa: F811
    with open_store(env.store, write=False) as con:
        batches = [
            b for (b,) in con.execute("SELECT DISTINCT batch_id FROM lake.points").fetchall()
        ]
        reference = set()
        for b in batches:
            reference |= set(con.execute(reference_qc.TRACK_QC, {"batch": b}).fetchall())
        stored = set(
            con.execute(
                "SELECT point_id, flag, reason FROM lake.qc_flags WHERE reason <> 'very_shallow'"
            ).fetchall()
        )
    reference = {r for r in reference if r[2] != "very_shallow"}
    return stored, reference


def track(seed, start, n, step):
    """A wandering track with noisy depths, spikes, jumps and fast legs."""
    rng = random.Random(seed)
    rows, lon, lat, s = [], LON0 + 0.2, LAT0 + 0.2, start
    for i in range(n):
        s += step * rng.choice([1, 1, 1, 1, 0, 2])  # repeated seconds too
        if rng.random() < 0.01:
            s += 5 * 3600  # a gap that starts a new transit
        lon += rng.uniform(-1, 1) * (0.004 if rng.random() < 0.05 else 0.0002)
        lat += rng.uniform(-1, 1) * 0.0002
        d = 12 + rng.uniform(-0.5, 0.5)
        if rng.random() < 0.04:
            d = rng.choice([3.0, 40.0])  # a spike either way
        rows.append((s, round(lon, 7), round(lat, 7), round(d, 2)))
    return rows


def test_ingest_qc_matches_the_reference_sql(env, sql_rules):  # noqa: F811
    # Tracks crossing several midnights (T0 is 18:00), with jumps and spikes around them.
    for n in range(1, 7):
        put_dated(env, n, track(n, -6 * 3600, 900, 60), f"V{n}")
    env.run("noaa")
    stored, reference = qc_both_ways(env)
    assert {r[2] for r in reference} >= {"jump", "spike"}
    assert stored == reference


def test_ingest_qc_matches_the_reference_sql_at_midnight_and_on_sparse_days(env, sql_rules):  # noqa: F811
    midnight = 6 * 3600  # T0 is 18:00
    near = [midnight - 3, midnight - 2, midnight - 1, midnight, midnight + 1, midnight + 2]
    # A spike on each side of midnight and a jump exactly at it.
    rows = [(s, *at(5000, i), 10.0) for i, s in enumerate(range(midnight - 300, midnight - 3, 60))]
    rows += [(near[0], *at(5000, 10), 30.0), (near[1], *at(5000, 11), 10.0)]
    rows += [(near[2], *at(5000, 12), 10.0), (near[3], LON0 + 0.5, LAT0, 10.0)]
    rows += [(near[4], *at(5000, 14), 2.0), (near[5], *at(5000, 15), 10.0)]
    rows += [
        (s, *at(5000, 16 + i), 10.0) for i, s in enumerate(range(midnight + 60, midnight + 400, 60))
    ]
    put_dated(env, 1, rows, "MIDNIGHT")
    # A spike decided by soundings five back across midnight: with them, the first
    # sounding after midnight (10 m) is a shoal spike against a median of 30 m.
    before = [30.0, 30.0, 30.0, 30.0, 10.0]
    after = [10.0, 10.0, 10.0, 10.0, 30.0, 30.0, 30.0, 30.0]
    edge = [(midnight - 50 + 10 * i, *at(7000, i), d) for i, d in enumerate(before)]
    edge += [(midnight + 10 * i, *at(7000, 5 + i), d) for i, d in enumerate(after)]
    put_dated(env, 3, edge, "EDGE")
    # A fix every 3 hours for 9 days: few soundings a day, and a 7-day split mid-day.
    put_dated(env, 2, [(i * 3 * 3600, *at(6000, i), 10.0 + (i % 3)) for i in range(72)], "SPARSE")
    env.run("noaa")
    stored, reference = qc_both_ways(env)
    assert ("reject", "jump") in {(f, r) for _, f, r in reference}
    assert ("unconfirmed", "spike") in {(f, r) for _, f, r in reference}
    assert stored == reference


@pytest.mark.parametrize("first", ["AQM-1", "AQM-2"])
def test_a_cells_sounding_sits_at_the_same_tie_whichever_file_came_first(env, first):  # noqa: F811
    # Two vessels read the same depth at the same time in one base cell.
    second = "AQM-2" if first == "AQM-1" else "AQM-1"
    spot = {"AQM-1": at(5000, 0, 0.25, 0.25), "AQM-2": at(5000, 0, 0.75, 0.75)}
    for n, vessel in enumerate([first, second], 1):
        put(env, n, [(0, *spot[vessel], 10.0)], vessel)
    build(env)
    placed = env.query("SELECT depth_lon, depth_lat FROM lake.cells WHERE level = 1")
    # The sounding with the least content key, whichever file holds it.
    assert placed == env.query(
        f"""SELECT lon, lat FROM lake.points p JOIN lake.files f USING (file_id)
        ORDER BY {catalog.CONTENT_KEY} LIMIT 1"""
    )


def two_tiles(env):  # noqa: F811
    """Two vessels along a line in each of two neighboring tiles; returns their ids."""
    for n, (dlon, vessel) in enumerate([(0, "AQM-1"), (0, "AQM-2"), (1, "AQM-1"), (1, "AQM-2")]):
        start = n % 2
        rows = [
            (start + i * 10, lon + dlon, lat, 10.0)
            for i, (_, lon, lat, _) in enumerate(line([10.0] * 6))
        ]
        put(env, n + 1, rows, vessel)
    tile = (LAT0 + 90) * 360 + LON0 + 180
    return tile, tile + 1


def group_tiles(con):
    return [t for (t,) in con.execute("SELECT DISTINCT tile_id FROM group_accepted").fetchall()]


def test_a_cells_build_that_stops_resumes_from_its_last_checkpoint(env, monkeypatch):  # noqa: F811
    # Every tile is its own group and every group a checkpoint; the second group fails.
    monkeypatch.setattr(cells, "BATCH_POINTS", 1)
    monkeypatch.setattr(catalog, "CHECKPOINT_SECONDS", 0)
    first, second = two_tiles(env)
    env.run("noaa")
    measure, measured = cells.measure, []

    def failing(con, rlo, rhi):
        if second in group_tiles(con):
            raise RuntimeError("R2 dropped the connection")
        return measure(con, rlo, rhi)

    monkeypatch.setattr(cells, "measure", failing)
    with pytest.raises(RuntimeError), open_store(env.store) as con:
        cells.build(con)
    # The first group was published; the marker wasn't.
    tiles = {t for (t,) in env.query("SELECT DISTINCT tile_id FROM lake.cells")}
    assert tiles == {first}
    assert env.query("SELECT count(*) FROM lake.store_meta WHERE key = 'cells'") == [(0,)]

    def counting(con, rlo, rhi):
        measured.extend(group_tiles(con))
        return measure(con, rlo, rhi)

    monkeypatch.setattr(cells, "measure", counting)
    with open_store(env.store) as con:
        assert cells.build(con)["kept"] > 0
    assert set(measured) == {second}
    assert env.query("SELECT count(*) FROM lake.store_meta WHERE key = 'cells'") == [(1,)]
    resumed = grid(env)
    # Finished, it keeps nothing: the next build of the same inputs rebuilds every tile.
    with open_store(env.store) as con:
        assert cells.build(con)["kept"] == 0
    assert grid(env) == resumed and {first, second} <= set(measured)


@pytest.mark.parametrize("since", ["ingest", "cleared", "older build", "rebuilt", "new code"])
def test_a_stopped_cells_build_keeps_nothing_that_changed_since(env, monkeypatch, since):  # noqa: F811
    monkeypatch.setattr(cells, "BATCH_POINTS", 1)
    monkeypatch.setattr(catalog, "CHECKPOINT_SECONDS", 0)
    first, second = two_tiles(env)
    env.run("noaa")
    measure = cells.measure

    def failing(con, rlo, rhi):
        if second in group_tiles(con):
            raise RuntimeError("stopped")
        return measure(con, rlo, rhi)

    monkeypatch.setattr(cells, "measure", failing)
    with pytest.raises(RuntimeError), open_store(env.store) as con:
        cells.build(con)
    monkeypatch.setattr(cells, "measure", measure)
    if since == "ingest":  # new soundings: other inputs
        put(env, 9, line([12.0] * 6, r=5100), "AQM-3")
        env.run("noaa")
    with open_store(env.store) as con:
        if since == "cleared":  # an older build cleared the tile
            con.execute("DELETE FROM lake.cells WHERE tile_id = ?", [first])
        if since == "older build":  # or rebuilt it with its own code
            con.execute(
                "UPDATE lake.cells SET grid_version = grid_version - 1 WHERE tile_id = ?", [first]
            )
        if since == "rebuilt":  # or, at this version, from inputs it has since lost again
            con.execute("UPDATE lake.cells SET depth = depth + 1 WHERE tile_id = ?", [first])
        if since == "new code":  # a cells fix shipped without a GRID_VERSION bump
            monkeypatch.setattr(cells, "CODE", "changed")
        assert cells.build(con)["kept"] == 0


def test_a_qc_run_that_stops_resumes_from_its_last_checkpoint(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(catalog, "CHECKPOINT_SECONDS", 0)
    monkeypatch.setattr(ingest, "FLUSH_POINTS", 1)  # a batch per file
    two_tiles(env)
    env.run("noaa")
    batches = [b for (b,) in env.query("SELECT DISTINCT batch_id FROM lake.points ORDER BY 1")]
    assert len(batches) == 4
    with open_store(env.store) as con:
        con.execute("DELETE FROM lake.qc_batches")  # as after a QC_VERSION bump
    run_batch, ran = qc.run_batch, []

    def failing(con, batch_id, fresh=False):
        if batch_id == batches[2]:
            raise RuntimeError("R2 dropped the connection")
        ran.append(batch_id)
        return run_batch(con, batch_id, fresh)

    monkeypatch.setattr(qc, "run_batch", failing)
    with pytest.raises(RuntimeError), open_store(env.store) as con:
        qc.run(con, missing_only=True)
    monkeypatch.setattr(
        qc,
        "run_batch",
        lambda con, b, fresh=False: ran.append(b) or run_batch(con, b, fresh),
    )
    ran.clear()
    with open_store(env.store) as con:
        qc.run(con, missing_only=True)
    assert ran == batches[2:]


def test_rebuilds_expire_old_snapshots_files_and_catalogs(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(catalog, "RETAIN", timedelta(0))
    put(env, 1, line([10.0, 10.0, 3.0, 10.0, 10.0, 10.0]))  # an unconfirmed shoal too
    put(env, 2, line([10.0] * 6, start=1), unique_id="AQM-2")
    build(env)
    lake = env.store.root / "lake"
    after = []
    for _ in range(3):
        with open_store(env.store) as con:
            assert cells.build(con)["kept"] == 0
        after.append(sum(1 for _ in lake.rglob("*.parquet")))
        catalogs = [o.key for o in env.store.list("catalog/")[0] if o.key.endswith(".ducklake")]
        assert len(catalogs) == 2  # this run's, and the one it started from
    assert after[0] == after[1] == after[2]
    assert grid(env)


def test_binned_confirmation_brackets_the_windowed_one():
    # Candidates in a few cells, with dense runs of near-equal depths, a few vessels
    # and passes, so every confirmation rule fires and bin edges are crossed.
    rng = random.Random(7)
    rows = []
    for i in range(20_000):
        cell = rng.randrange(2000)
        d = rng.uniform(0.5, 60) if cell % 4 else 4.0 + rng.randrange(40) / 10
        vessel = f"V{rng.randrange(1 + cell % 3)}"
        t = T0 + timedelta(hours=rng.choice([0, 0, 0, 5]) * (cell % 2), seconds=i)
        rows.append((i, cell, d, vessel, t, "shoal" if rng.random() < 0.9 else None))
    con = duckdb.connect()
    con.execute(
        """CREATE TEMP TABLE classed (point_id INTEGER, cc INTEGER, d DOUBLE, vessel VARCHAR,
        time TIMESTAMP, outlier VARCHAR, tile_id INTEGER DEFAULT 0, level INTEGER DEFAULT 9,
        cr INTEGER DEFAULT 0)"""
    )
    con.executemany(
        "INSERT INTO classed (point_id, cc, d, vessel, time, outlier) VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    con.execute(
        "ALTER TABLE classed ADD COLUMN raw DOUBLE; UPDATE classed SET raw = d;"
        " ALTER TABLE classed ADD COLUMN hunting BOOLEAN DEFAULT false"
    )
    con.execute(cells.CONFIRM)
    binned = {p for (p,) in con.execute("SELECT point_id FROM confirmed").fetchall()}

    def windowed(step):
        return {p for (p,) in con.execute(reference_qc.windowed_confirm(step)).fetchall()}

    tolerance = windowed(math.log(1.05))
    assert tolerance <= binned <= windowed(2 * math.log(1.05))
    assert 0 < len(tolerance) < len(binned) < len(rows) * 0.9 * 0.9


def test_a_shoal_dedupe_dropped_doesnt_publish(env):  # noqa: F811
    # NOAA's copy of an Open Waters track has a 3 m spike in a base cell the Open
    # Waters track skips. Rule 5 drops NOAA's copy, so the shoal isn't published.
    vessel = "SIGNALK-" + VESSEL
    env.ow.put(ow_key(1), geojson([(s, *at(5000, s), 10.0) for s in (0, 2, 3, 4, 5)]))
    put(env, 1, [(s, *at(5000, s), 3.0 if s == 1 else 10.0) for s in range(6)], vessel)
    put(env, 2, [(0, *at(4999, 0), 10)], "B")
    env.run()
    with open_store(env.store) as con:
        cells.build(con)
    assert ("unconfirmed", "spike", 3) in flags(env)
    assert env.query("SELECT * FROM lake.shoals") == []


def test_cells_count_a_soundings_twins_once(env):  # noqa: F811
    # Two uploads from one vessel overlap by three soundings, so neither covers the other.
    rows = line([10.0, 10.2, 10.1, 10.3, 10.0, 10.2, 10.1, 10.3, 10.0])
    put(env, 1, rows[:6])
    put(env, 2, rows[3:])
    build(env)
    assert [s for (s,) in env.query("SELECT status FROM lake.files")] == ["active"] * 2
    assert sum(row[5] for row in grid(env)) == 9


def test_a_depth_held_over_a_kilometre_is_a_stuck_sounder(env):  # noqa: F811
    # A sounding every 30 s, 10 base cells (about 86 m) apart: a sounder that lost
    # bottom holds 601.5 m for 13 soundings, just over a kilometre, in 290 m water.
    depths = [290.0, 291.0, 289.0, 290.0] + [601.5] * 13 + [290.0, 288.0, 291.0]
    put(env, 1, [(i * 30, *at(5000, i * 10), d) for i, d in enumerate(depths)], "SHIP")
    # A slow boat over a flat bottom: 5 m for 40 soundings, about 370 m.
    put(env, 2, [(i * 10, *at(6000, i), 5.0) for i in range(40)], "BOAT")
    # A sparse logger: two equal soundings 1.2 km apart are two readings, not a run.
    put(env, 3, [(0, *at(7000, 0), 20.0), (600, *at(7000, 140), 20.0)], "SPARSE")
    env.run("noaa")
    flat = [d for flag, reason, d in flags(env) if reason == "flatline"]
    assert flat == [601.5] * 13
    assert all(flag == "reject" for flag, reason, _ in flags(env) if reason == "flatline")


def test_a_moored_boat_holding_its_depth_isnt_a_stuck_sounder(env):  # noqa: F811
    # A fix every 5 s for 40 minutes, wandering 3 m about its mooring at a steady 4.2 m:
    # 1.4 km of path over one spot.
    put(
        env, 1, [(i * 5, *at(5000, 0, 0.5, 0.3 + 0.3 * (i % 2)), 4.2) for i in range(480)], "MOORED"
    )
    build(env)
    assert not [f for f in flags(env) if f[1] == "flatline"]
    assert grid(env)


def test_a_sounder_stuck_on_a_boat_drifting_in_shallow_water_isnt_caught(env):  # noqa: F811
    # The accepted risk: a boat drifting within 200 m in water under 30 m with its sounder
    # stuck at 12.0 m isn't flagged. The held reading came from within those 200 m, so its
    # error is at most the depth change across them.
    drift = [(i * 5, *at(5000 + i % 20, (i // 20) % 2, 0.5, 0.5), 12.0) for i in range(480)]
    put(env, 1, drift, "DRIFTER")
    env.run("noaa")
    assert not [f for f in flags(env) if f[1] == "flatline"]


def test_a_sounder_stuck_on_a_boat_drifting_in_deep_water_is_rejected(env):  # noqa: F811
    # The same drift with its sounder holding 601.5 m: deep, the path alone decides.
    drift = [(i * 5, *at(5000 + i % 20, (i // 20) % 2, 0.5, 0.5), 601.5) for i in range(480)]
    put(env, 1, drift, "DRIFTER")
    env.run("noaa")
    assert {f for f, reason, _ in flags(env) if reason == "flatline"} == {"reject"}


def test_a_flat_shoal_a_coarse_sounder_read_stays_unconfirmed(env):  # noqa: F811
    # A boat crosses a flat 2.0 m mud shoal 14 3″ cells (126 base cells, 1.17 km) long,
    # with 3.0 m water in the 3″ cells either side: the run is unconfirmed, not rejected,
    # and no cell over it publishes deeper water.
    depths = [3.0] * 9 + [2.0] * 126 + [3.0] * 9
    put(env, 1, [(i * 4, *at(5004, i), d) for i, d in enumerate(depths)], "SKIFF")
    build(env)
    assert {f for f, reason, d in flags(env) if reason == "flatline"} == {"unconfirmed"}
    assert len([1 for _, reason, d in flags(env) if reason == "flatline" and d == 2.0]) >= 120
    lon_lo, _ = at(5004, 9, 0, 0)
    lon_hi, _ = at(5004, 135, 0, 0)
    over = env.query(
        "SELECT depth FROM lake.cells WHERE lon_max > ? AND lon_min < ? AND depth > 2.0",
        [lon_lo, lon_hi],
    )
    assert over == []


def consensus(env, others, vessel_depths):  # noqa: F811
    """Soundings in one 3″ block: `others` vessels at the given depths, each three times,
    and then each (vessel, depth) of `vessel_depths` once."""
    n = 0
    for i, d in enumerate(others):
        n += 1
        put(env, n, [(s, *at(5000 + s, i), d + s * 0.1) for s in range(3)], f"OTHER{i}")
    for vessel, d in vessel_depths:
        n += 1
        put(env, n, [(0, *at(5004, 8), d)], vessel)
    build(env)
    return {(reason, d) for flag, reason, d in flags(env) if reason.startswith("consensus")}


def test_consensus_rejects_a_sounder_that_lost_bottom(env):  # noqa: F811
    # Four vessels read about 290 m; one reads 601 m, another a 20 m echo nobody else saw.
    got = consensus(env, [290, 291, 289, 290], [("DEEP", 601.5), ("ECHO", 20.0)])
    assert got == {("consensus_deep", 601.5), ("consensus_shoal", 20.0)}


@pytest.mark.parametrize("d, flag", [(20.0, "unconfirmed"), (150.0, "reject")])
def test_a_disproved_shoal_that_could_be_a_hazard_stays_unconfirmed(env, d, flag):  # noqa: F811
    # Four vessels read about 290 m and one a shoal no other vessel read: shallow enough
    # to be a rock, it publishes unconfirmed; deeper, it's a stray echo.
    consensus(env, [290, 291, 289, 290], [("ECHO", d)])
    assert (flag, "consensus_shoal", d) in flags(env)


def test_consensus_keeps_a_shoal_it_cant_disprove(env):  # noqa: F811
    # Two other vessels aren't enough to disprove a shoal.
    assert consensus(env, [290, 291], [("ECHO", 20.0)]) == set()


def test_consensus_keeps_a_shoal_another_vessel_read(env):  # noqa: F811
    # Three vessels agree on 290 m, but a fourth read 21 m in the same block.
    put(env, 50, [(0, *at(5004, 6), 21.0)], "OTHER3")
    assert consensus(env, [290, 291, 289], [("ECHO", 20.0)]) == set()


@pytest.mark.parametrize(
    "readings",
    [
        [(0, 5004, 12, 21.0)],  # the same depth, but in the next block
        [(0, 5004, 6, 40.0)],  # in the block, but much deeper: a stray echo
        [(0, 5004, 6, 5.0)],  # in the block, but much shoaler: another stray echo
    ],
)
def test_consensus_needs_the_same_depth_close_by_to_keep_a_shoal(env, readings):  # noqa: F811
    put(env, 50, [(t, *at(r, c), d) for t, r, c, d in readings], "OTHER3")
    assert ("consensus_shoal", 20.0) in consensus(env, [290, 291, 289], [("ECHO", 20.0)])


def test_consensus_doesnt_count_a_shoal_its_own_vessel_read_again(env):  # noqa: F811
    # ECHO reads 20 m twice in the block; only another vessel's reading corroborates.
    put(env, 50, [(60, *at(5004, 6), 20.5)], "ECHO")
    assert ("consensus_shoal", 20.0) in consensus(env, [290, 291, 289], [("ECHO", 20.0)])


def test_consensus_widens_where_vessels_disagree(env):  # noqa: F811
    # A slope: other vessels a block apart read 20 to 60 m, so 70 m isn't an outlier.
    assert consensus(env, [20, 35, 45, 60], [("SLOPE", 70.0)]) == set()


@pytest.mark.parametrize(
    "box", ["-76,37,-76,38", "179.5,-1,-179.5,1", "-76,38,-75,37", "-181,37,-179,38", "0,0,inf,1"]
)
def test_a_box_touching_no_tiles_is_refused(box):
    from grid.cli import main

    with pytest.raises(SystemExit):
        main(["--store", "unused", "cells", "--bbox", box])


def test_cells_builds_a_western_box(env):  # noqa: F811
    from grid.cli import main

    put(env, 1, line([10.0] * 6))
    put(env, 2, line([10.0] * 6, start=1), unique_id="AQM-2")
    env.run("noaa")
    main(["--store", str(env.store.root), "cells", f"--bbox={LON0},{LAT0},{LON0 + 1},{LAT0 + 1}"])
    assert grid(env)


def test_a_build_of_no_tiles_is_refused(env):  # noqa: F811
    with open_store(env.store) as con, pytest.raises(ValueError):
        cells.build(con, [])


def test_a_bbox_names_the_tiles_it_touches():
    from grid.cli import bbox

    # Chesapeake Bay: 36.8-39.7°N, 77.5-75.5°W.
    tiles = bbox("-77.5,36.8,-75.5,39.7")
    assert len(tiles) == 4 * 3
    assert (36 + 90) * 360 + (-78 + 180) in tiles and (39 + 90) * 360 + (-76 + 180) in tiles
