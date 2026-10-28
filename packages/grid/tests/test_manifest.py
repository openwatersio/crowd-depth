from datetime import datetime

import pytest
from test_ingest import ROWS, env, noaa_csv, noaa_key  # noqa: F401  (env is a fixture)

from grid import manifest
from grid.catalog import open_store

# Two tiles, a degree apart: the fixture's and the one north of it.
NORTH = [(s, lon, lat + 1, d) for s, lon, lat, d in ROWS]
SOUTH_TILE, NORTH_TILE = 123 * 360 + 101, 124 * 360 + 101


def file_tiles(env):  # noqa: F811
    return env.query(
        "SELECT file_id, tile_id, cell_id, batch_id, n FROM lake.file_tiles ORDER BY ALL"
    )


def two_tiles(env):  # noqa: F811
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    env.noaa.put(noaa_key(2), noaa_csv(NORTH, unique_id="AQM-2"))
    env.run("noaa")


def prints(env, change=None):  # noqa: F811
    # Read only: a change is made in this open's copy alone, and never published.
    with open_store(env.store, write=False) as con:
        if change:
            change(con)
        return {t: fp for t, (fp, _) in manifest.fingerprints(con).items()}


def test_ingest_records_each_files_soundings_per_tile(env):  # noqa: F811
    two_tiles(env)
    assert file_tiles(env) == env.query(
        """SELECT file_id, tile_id, cell_id, batch_id, count(*) FROM lake.points
        GROUP BY ALL ORDER BY ALL"""
    )
    assert {t for _, t, *_ in file_tiles(env)} == {SOUTH_TILE, NORTH_TILE}


def test_a_copy_taking_over_a_files_points_takes_their_tiles(env):  # noqa: F811
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, file_uuid="a"))
    env.noaa.put(noaa_key(2), noaa_csv(ROWS, file_uuid="b"))
    env.noaa.put(noaa_key(3), noaa_csv(NORTH, unique_id="AQM-2"))
    env.run("noaa")
    env.noaa.delete(noaa_key(1))
    env.run("noaa")
    [(taker,)] = env.query("SELECT file_id FROM lake.files WHERE key = ?", [noaa_key(2)])
    assert taker in {f for f, *_ in file_tiles(env)}
    assert file_tiles(env) == env.query(
        """SELECT file_id, tile_id, cell_id, batch_id, count(*) FROM lake.points
        GROUP BY ALL ORDER BY ALL"""
    )


def test_a_store_without_file_tiles_is_filled_from_its_points(env):  # noqa: F811
    two_tiles(env)
    written = file_tiles(env)
    with open_store(env.store) as con:
        con.execute("DELETE FROM lake.file_tiles WHERE tile_id = ?", [NORTH_TILE])
        assert manifest.ensure_file_tiles(con) == 1
        assert manifest.ensure_file_tiles(con) == 0
    assert file_tiles(env) == written


def test_a_tiles_fingerprint_moves_with_its_inputs_alone(env):  # noqa: F811
    two_tiles(env)
    base = prints(env)
    assert set(base) == {SOUTH_TILE, NORTH_TILE}
    [(south,)] = env.query("SELECT file_id FROM lake.files WHERE key = ?", [noaa_key(1)])
    day = datetime(2026, 10, 13)

    def tide_cells(con):
        con.execute(
            "INSERT INTO lake.tide_cells VALUES (1, ?, 7, 3.0), (2, ?, 8, 3.0)",
            [SOUTH_TILE, NORTH_TILE],
        )

    changes = {
        # Inputs a tile's cells read: only that tile moves.
        "offset": (
            lambda c: c.execute(
                "INSERT INTO lake.file_offsets VALUES (?, 'AQM-1', -1.0, 0.1, false, false)",
                [south],
            ),
            {SOUTH_TILE},
        ),
        "stuck run": (
            lambda c: c.execute(
                """INSERT INTO lake.lost_runs SELECT content_hash, vessel, ?, time_min, time_max
            FROM lake.files WHERE file_id = ?""",
                [SOUTH_TILE, south],
            ),
            {SOUTH_TILE},
        ),
        # Both files came in one batch, which QC reruns whole.
        "QC rerun": (
            lambda c: c.execute(
                """UPDATE lake.qc_batches SET qc_version = qc_version + 1 WHERE batch_id IN (
              SELECT batch_id FROM lake.file_tiles WHERE file_id = ?)""",
                [south],
            ),
            {SOUTH_TILE, NORTH_TILE},
        ),
        "withdrawal": (
            lambda c: c.execute(
                "UPDATE lake.files SET status = 'withdrawn' WHERE file_id = ?", [south]
            ),
            {SOUTH_TILE},
        ),
        "station": (tide_cells, {SOUTH_TILE, NORTH_TILE}),
        # An ETag alone changes no sounding.
        "etag": (lambda c: c.execute("UPDATE lake.files SET etag = 'x'"), set()),
    }
    for name, (change, moved) in changes.items():
        got = prints(env, change)
        assert {t for t in base if got[t] != base[t]} == moved, name

    # A level on a day the tile's soundings cover moves it; one on another day doesn't.
    with open_store(env.store) as con:
        tide_cells(con)
    covered = prints(env)

    def level(slot):
        return lambda c: c.execute(
            "INSERT INTO lake.tide_levels VALUES (7, ?, 0.5, 0, 0.1, 'test')", [slot]
        )

    assert prints(env, level(day))[SOUTH_TILE] != covered[SOUTH_TILE]
    assert prints(env, level(datetime(2020, 1, 1))) == covered


def test_an_open_waters_copy_moves_the_noaa_files_tile(env):  # noqa: F811
    two_tiles(env)
    base = prints(env)

    def copy(con):
        # The plugin's own file of the vessel whose NOAA copy is in the south tile.
        con.execute(
            """INSERT INTO lake.files SELECT * REPLACE (9999 AS file_id, 'openwaters' AS source,
              'ow.geojson' AS key, false AS has_points)
            FROM lake.files WHERE key = ?""",
            [noaa_key(1)],
        )

    got = prints(env, copy)
    assert got[SOUTH_TILE] != base[SOUTH_TILE] and got[NORTH_TILE] == base[NORTH_TILE]


def test_a_tide_cells_distance_alone_moves_its_tile(env):  # noqa: F811
    two_tiles(env)
    with open_store(env.store) as con:
        con.execute("INSERT INTO lake.tide_cells VALUES (1, ?, 7, 3.0)", [SOUTH_TILE])
    base = prints(env)
    got = prints(env, lambda c: c.execute("UPDATE lake.tide_cells SET km = 10.0"))
    assert got[SOUTH_TILE] != base[SOUTH_TILE] and got[NORTH_TILE] == base[NORTH_TILE]


def test_an_open_waters_copy_within_the_same_second_moves_the_noaa_files_tile(env):  # noqa: F811
    two_tiles(env)
    base = prints(env)

    def copy(con):
        # Starting half a second after the NOAA file's last sounding: the dedupe widens it to
        # the whole second, which takes that sounding.
        con.execute(
            """INSERT INTO lake.files SELECT * REPLACE (9999 AS file_id, 'openwaters' AS source,
              'ow.geojson' AS key, false AS has_points, time_max + INTERVAL 500 MILLISECOND AS time_min,
              time_max + INTERVAL 900 MILLISECOND AS time_max)
            FROM lake.files WHERE key = ?""",
            [noaa_key(1)],
        )

    assert prints(env, copy)[SOUTH_TILE] != base[SOUTH_TILE]


def test_file_tiles_left_behind_by_an_older_build_are_reconciled(env):  # noqa: F811
    two_tiles(env)
    written = file_tiles(env)
    [(south,)] = env.query("SELECT file_id FROM lake.files WHERE key = ?", [noaa_key(1)])
    with open_store(env.store) as con:
        # An older build's take-over: the points moved to a copy, and the rows stayed.
        con.execute(
            """INSERT INTO lake.files SELECT * REPLACE (9999 AS file_id, key || '.copy' AS key)
            FROM lake.files WHERE file_id = ?""",
            [south],
        )
        con.execute("UPDATE lake.files SET has_points = false WHERE file_id = ?", [south])
        con.execute("UPDATE lake.points SET file_id = 9999 WHERE file_id = ?", [south])
        # Read before filling: the rows don't cover the copy's points.
        with pytest.raises(RuntimeError, match="ensure_file_tiles"):
            manifest.fingerprints(con)
        assert manifest.ensure_file_tiles(con) == 1
        manifest.fingerprints(con)
    moved = [(9999 if f == south else f, *rest) for f, *rest in written]
    assert file_tiles(env) == sorted(moved)


def test_a_file_whose_points_dont_match_its_count_is_named(env):  # noqa: F811
    two_tiles(env)
    [(south,)] = env.query("SELECT file_id FROM lake.files WHERE key = ?", [noaa_key(1)])
    with open_store(env.store, write=False) as con:
        con.execute(
            "UPDATE lake.files SET point_count = point_count + 1 WHERE file_id = ?", [south]
        )
        with pytest.raises(RuntimeError, match=f"point_count: \\[{south}\\]"):
            manifest.ensure_file_tiles(con)
