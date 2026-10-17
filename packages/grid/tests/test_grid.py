import math
import random
import struct
from datetime import date, datetime, timedelta

import duckdb
import pyarrow as pa
import pytest
import reference_qc
from test_ingest import HEADER, VESSEL, env, geojson, ow_key  # noqa: F401  (env is a fixture)

from grid import catalog, cells, qc
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
            """SELECT q.flag, q.reason, p.depth_raw FROM lake.qc_flags q
            JOIN lake.points p USING (point_id)"""
        )
    )


def grid(env):  # noqa: F811
    return env.query(
        """SELECT level, "row", col, depth, median, count, vessels, kind, first, last
        FROM lake.cells ORDER BY level, "row", col"""
    )


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
    assert all(1200 % cells.k_for(lat) == 0 for lat in range(-90, 90))


def test_levels_follow_vessel_counts(env):  # noqa: F811
    # Two vessels in one 1″ cell: base cells. One vessel alone: a 3″ cell.
    put(env, 1, [(0, *at(4998, 0), 10)], "A")
    put(env, 2, [(0, *at(4999, 1), 11)], "B")
    put(env, 3, [(0, *at(6000, 0), 12)], "C")
    # One vessel in its 1″ cell, another elsewhere in the 3″ cell: a 1″ cell.
    put(env, 4, [(0, *at(7000, 0), 13)], "D")
    put(env, 5, [(0, *at(7001, 5), 14)], "E")
    build(env)
    got = {(lv, r, c) for lv, r, c, *_ in grid(env) if _[4] != "filled"}
    assert got == {
        (1, 4998, 0),
        (1, 4999, 1),
        (9, 6000 // 9, 0),
        (3, 7000 // 3, 0),
        (3, 7001 // 3, 1),
    }


def test_depth_is_a_real_shoal_biased_sounding(env):  # noqa: F811
    depths = [6 + (i * 7 % 20) / 10 for i in range(20)]  # 6.0 to 7.9, shuffled
    for i, d in enumerate(depths):
        # One sounding per vessel, so no track spike tests apply.
        put(env, i + 1, [(i, *at(5000, 0, 0.02 + i * 0.045, 0.5), d)], f"V{i}")
    build(env)
    [(level, _, _, depth, median, count, vessels, kind, first, last)] = grid(env)
    assert (level, count, vessels, kind) == (1, 20, 20, "multi")
    # The 10th percentile of 20 soundings is the second shoalest, an actual sounding.
    assert depth == float32(sorted(depths)[1]) and depth <= median
    assert (first, last) == (date(2026, 10, 1), date(2026, 10, 1))


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
    assert grid(env)[0][3] == float32(9.9)

    # A second vessel sounding the shoal within its tolerance confirms it.
    put(env, 9, [(20, *at(5000, 0, 0.9), 2.5)], "V9")
    build(env)
    # Two other vessels now vote on the 30 m sounding, and it's far deeper than both.
    assert flags(env) == [("reject", "consensus_deep", 30)]
    assert grid(env)[0][3] == 2.0


def test_track_shoal_spike_confirmed_by_another_vessel(env):  # noqa: F811
    put(env, 1, line([10, 10, 10, 10, 3, 10, 10, 10, 10]))
    put(env, 2, [(100, *at(5000, 4, 0.2), 3.4)], "AQM-2")
    build(env)
    assert ("confirmed", "cell_confirmed", 3) in flags(env)


def holes(cells_):
    """Run the hole query over cells (row, col, depth, level) in one tile."""
    t = 123 * 360 + 102
    table = pa.Table.from_pylist(
        [
            {"tile_id": t, "level": lv, "row": r, "col": c, "depth": d, "tvu": 2.5, "cell_id": 1}
            for r, c, d, lv in cells_
        ]
    )
    con = duckdb.connect()
    con.register("measured", table)
    con.execute("CREATE TABLE shoal_cells (tile_id INTEGER, r INTEGER, c INTEGER)")
    query = f'SELECT "row", col, depth, kind FROM ({cells.HOLES})'
    return sorted(con.execute(query, {"rlo": 0, "rhi": cells.BASE}).fetchall())


def test_holes_fill_between_opposite_sides_with_the_shoaler():
    assert holes([(10, 10, 5.0, 1), (10, 12, 4.0, 1)]) == [(10, 11, 4.0, "filled")]
    # One side only, or two cells apart: nothing.
    assert holes([(10, 10, 5.0, 1)]) == []
    assert holes([(10, 10, 5.0, 1), (10, 13, 4.0, 1)]) == []
    # A coarse cell covers its area and brackets base holes beside it.
    assert holes([(1, 1, 6.0, 9), (10, 19, 3.0, 1)]) == [
        (10, 18, 3.0, "filled"),
        (11, 18, 3.0, "filled"),
    ]
    # Filled cells never fill others: a gap of two stays open.
    assert holes([(10, 10, 5.0, 1), (10, 13, 4.0, 1), (9, 11, 4.5, 1)]) == []


def test_aggregated_cells_keep_their_shoalest_base_cell(env):  # noqa: F811
    # One vessel, so the 3″ cell is published. One base cell holds a single 12 m
    # sounding among 49 at 14 to 20 m elsewhere: the 3″ cell's own 10th percentile
    # would be about 14 m, but it keeps the shoalest base cell's 12 m. Soundings are
    # five hours apart, each its own transit, so the track spike test leaves them alone.
    rows = [(-i * 5 * 3600, *at(4995 + i % 8, i // 8), 14 + (i * 13 % 49) / 8) for i in range(49)]
    rows.append((-50 * 5 * 3600, *at(5003, 8), 12.0))
    put(env, 1, rows)
    build(env)
    [(level, *_, depth, _median, count, _vessels, _kind, _first, _last)] = grid(env)
    assert (level, count, depth) == (9, 50, 12.0)


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
    assert [row[3] for row in grid(env)] == [10]


def test_a_feature_one_track_crosses_is_not_noise(env):  # noqa: F811
    # A channel edge inside one single-vessel 3″ cell: 21 soundings at 12 m, 9 at 3 m.
    rows = [(0, *at(4995 + i % 3, i // 3), 12.0) for i in range(21)]
    rows += [(0, *at(4998 + i % 3, i // 3), 3.0) for i in range(9)]
    put(env, 1, apart(rows))
    build(env)
    [row] = grid(env)
    assert (row[0], row[5], row[3]) == (9, 30, 3.0)  # level, count, depth
    assert flags(env) == []


def test_levels_count_only_vessels_with_accepted_soundings(env):  # noqa: F811
    rows = [(0, *at(5000, 0, 0.1 + i * 0.1), 10.0) for i in range(5)]
    rows += [(0, *at(5000, 1), 10.0), (0, *at(5000, 2), 10.0)]
    put(env, 1, apart(rows))
    put(env, 2, [(0, *at(5000, 0, 0.9), 60.0)], "B")  # rejected as deeper than its cell
    build(env)
    assert [row[:3] for row in grid(env) if row[7] != "filled"] == [(9, 5000 // 9, 0)]
    assert ("reject", "cell_deep", 60) in flags(env)


def test_confirmed_shoals_set_the_depth_however_many_soundings(env):  # noqa: F811
    for i in range(30):
        put(env, i + 1, [(i, *at(5000, 0, 0.02 + i * 0.03), 10.0)], f"V{i}")
    put(env, 31, [(40, *at(5000, 0, 0.95), 2.0)], "R1")
    put(env, 32, [(41, *at(5000, 0, 0.97), 2.3)], "R2")
    build(env)
    [row] = grid(env)
    assert row[3] == 2.0


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
    build(env)
    whole = grid(env)
    monkeypatch.setattr(cells, "BATCH_POINTS", 5)
    with open_store(env.store) as con:
        [(partition,)] = con.execute("SELECT DISTINCT cell_id FROM lake.points").fetchall()
        assert len(cells.units(con, partition, [])) > 2
        cells.build(con)
    assert grid(env) == whole
    assert any(row[7] == "filled" for row in whole)


def test_a_lone_ping_shoaler_than_its_cell_stays_unconfirmed(env):  # noqa: F811
    # Within 2 m + 5% of the cell's soundings, but it stands out from them, and
    # nothing else that stands out agrees with it.
    for i in range(20):
        put(env, i + 1, [(i, *at(5000, 0, 0.02 + i * 0.045), 10.0)], f"V{i}")
    put(env, 21, [(30, *at(5000, 0, 0.97), 8.5)], "X")
    build(env)
    assert flags(env) == [("unconfirmed", "cell_shoal", 8.5)]
    assert grid(env)[0][3] == 10.0


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


def test_sampled_cells_still_publish_an_actual_sounding(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(cells, "CELL_SAMPLE", 4)
    depths = [10 + (i * 7 % 40) / 10 for i in range(40)]
    put(env, 1, apart([(0, *at(5000, 0, 0.01 + i * 0.024), d) for i, d in enumerate(depths)]))
    build(env)
    [row] = grid(env)
    depth, median, count = row[3], row[4], row[5]
    assert count == 40 and depth <= median and float32(depth) in [float32(d) for d in depths]


def test_holes_never_cover_an_unconfirmed_shoal(env):  # noqa: F811
    # A's 3 m spike at (5000, 1) stays unconfirmed; B makes the 1″ cell multi-vessel,
    # so base cells publish and (5000, 1) sits between sounded cells.
    put(env, 1, line([10, 3, 10, 10, 10, 10, 10, 10]))
    put(env, 2, [(0, *at(4999, 0), 10)], "B")
    build(env)
    assert ("unconfirmed", "spike", 3) in flags(env)
    assert [row for row in grid(env) if row[:3] == (1, 5000, 1)] == []


def put_dated(env, n, rows, unique_id, day="2026/10/22"):  # noqa: F811
    """Like put, under a later folder date, so a week of soundings isn't after arrival."""
    key = f"csb/csv/{day}/{day.replace('/', '')}{n:06d}000000_{n}_pointData.csv"
    env.noaa.put(key, csv(rows, unique_id))


def qc_both_ways(env):  # noqa: F811
    with open_store(env.store, write=False) as con:
        batches = [
            b for (b,) in con.execute("SELECT DISTINCT batch_id FROM lake.points").fetchall()
        ]
        reference = set()
        for b in batches:
            reference |= set(con.execute(reference_qc.TRACK_QC, {"batch": b}).fetchall())
        split = set(
            con.execute(
                "SELECT point_id, flag, reason FROM lake.qc_flags WHERE reason <> 'very_shallow'"
            ).fetchall()
        )
    reference = {r for r in reference if r[2] != "very_shallow"}
    return split, reference


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


def test_day_split_qc_matches_one_pass(env):  # noqa: F811
    # Tracks crossing several midnights (T0 is 18:00), with jumps and spikes around them.
    for n in range(1, 7):
        put_dated(env, n, track(n, -6 * 3600, 900, 60), f"V{n}")
    env.run("noaa")
    split, reference = qc_both_ways(env)
    assert {r[2] for r in reference} >= {"jump", "spike"}
    assert split == reference


def test_day_split_qc_at_midnight_and_on_sparse_days(env):  # noqa: F811
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
    split, reference = qc_both_ways(env)
    assert ("reject", "jump") in {(f, r) for _, f, r in reference}
    assert ("unconfirmed", "spike") in {(f, r) for _, f, r in reference}
    assert split == reference


def test_rebuilds_expire_old_snapshots_files_and_catalogs(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(catalog, "RETAIN", timedelta(0))
    put(env, 1, line([10.0] * 6))
    put(env, 2, line([10.0] * 6, start=1), unique_id="AQM-2")
    build(env)
    lake = env.store.root / "lake"
    after = []
    for _ in range(3):
        with open_store(env.store) as con:
            cells.build(con)
        after.append(sum(1 for _ in lake.rglob("*.parquet")))
        catalogs = [o.key for o in env.store.list("catalog/")[0] if o.key.endswith(".ducklake")]
        assert len(catalogs) == 1
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
    con.execute(cells.CONFIRM)
    binned = {p for (p,) in con.execute("SELECT point_id FROM confirmed").fetchall()}

    def windowed(step):
        return {p for (p,) in con.execute(reference_qc.windowed_confirm(step)).fetchall()}

    tolerance = windowed(math.log(1.05))
    assert tolerance <= binned <= windowed(2 * math.log(1.05))
    assert 0 < len(tolerance) < len(binned) < len(rows) * 0.9 * 0.9


def test_a_shoal_dedupe_dropped_doesnt_hold_a_hole_open(env):  # noqa: F811
    # NOAA's copy of an Open Waters track has a 3 m spike in a base cell the Open
    # Waters track skips. Rule 5 drops NOAA's copy, so the cell is an ordinary hole.
    vessel = "SIGNALK-" + VESSEL
    env.ow.put(ow_key(1), geojson([(s, *at(5000, s), 10.0) for s in (0, 2, 3, 4, 5)]))
    put(env, 1, [(s, *at(5000, s), 3.0 if s == 1 else 10.0) for s in range(6)], vessel)
    put(env, 2, [(0, *at(4999, 0), 10)], "B")
    env.run()
    with open_store(env.store) as con:
        cells.build(con)
    assert ("unconfirmed", "spike", 3) in flags(env)
    [hole] = [row for row in grid(env) if row[:3] == (1, 5000, 1)]
    assert hole[7] == "filled"


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


def test_consensus_widens_where_vessels_disagree(env):  # noqa: F811
    # A slope: other vessels a block apart read 20 to 60 m, so 70 m isn't an outlier.
    assert consensus(env, [20, 35, 45, 60], [("SLOPE", 70.0)]) == set()


def test_a_bbox_names_the_tiles_it_touches():
    from grid.cli import bbox

    # Chesapeake Bay: 36.8-39.7°N, 77.5-75.5°W.
    tiles = bbox("-77.5,36.8,-75.5,39.7")
    assert len(tiles) == 4 * 3
    assert (36 + 90) * 360 + (-78 + 180) in tiles and (39 + 90) * 360 + (-76 + 180) in tiles
