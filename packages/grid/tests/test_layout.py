import pytest
from test_ingest import ROWS, env, noaa_csv, noaa_key  # noqa: F401  (env is a fixture)

from grid import catalog
from grid.catalog import open_store


def columns(con, table):
    return {
        c
        for (c,) in con.execute(
            "SELECT column_name FROM duckdb_columns() WHERE database_name = 'lake' AND table_name = ?",
            [table],
        ).fetchall()
    }


def test_a_copy_taking_over_a_files_points_takes_their_flags(env):  # noqa: F811
    env.noaa.put(noaa_key(1), noaa_csv(ROWS, file_uuid="a"))
    env.noaa.put(noaa_key(2), noaa_csv(ROWS, file_uuid="b"))
    # Another vessel's file, so one withdrawal isn't every active file and isn't held.
    env.noaa.put(noaa_key(3), noaa_csv(ROWS, unique_id="AQM-2"))
    env.run("noaa")
    holder, taker = (
        env.query("SELECT file_id FROM lake.files WHERE key = ?", [noaa_key(n)])[0][0]
        for n in (1, 2)
    )
    with open_store(env.store) as con:
        con.execute(
            f"""INSERT INTO lake.qc_flags SELECT {catalog.POINT_ID}, 'reject', 'spike', 99,
              cell_id, tile_id FROM lake.points p WHERE file_id = ? AND "row" = 1""",
            [holder],
        )
    env.noaa.delete(noaa_key(1))
    env.run("noaa")
    assert env.query("SELECT file_id FROM lake.files WHERE has_points AND key = ?", [noaa_key(2)])
    assert env.query(
        "SELECT point_id >> 32, point_id & 4294967295 FROM lake.qc_flags WHERE qc_version = 99"
    ) == [(taker, 1)]


def track(lat, n=1500):
    """A track of `n` soundings, more than DuckLake inlines, so they're written to Parquet."""
    return [(i // 30, -78.1 + i * 1e-5, lat, 5.0 + 0.01 * (i % 7)) for i in range(n)]


def point_files(con):
    files = [
        f
        for (f,) in con.execute(
            "SELECT data_file FROM ducklake_list_files('lake', 'points')"
        ).fetchall()
    ]
    return [
        [t for (t,) in con.execute(f"SELECT tile_id FROM read_parquet('{f}')").fetchall()]
        for f in files
    ]


def test_a_store_in_ingest_order_moves_to_the_sorted_layout(env):  # noqa: F811
    env.noaa.put(noaa_key(1), noaa_csv(track(34.1)))
    env.noaa.put(noaa_key(2), noaa_csv(track(33.1), unique_id="AQM-2"))
    env.run("noaa")
    before = env.query('SELECT file_id, "row", tile_id, depth_raw FROM lake.points ORDER BY ALL')
    # As a store from before the layout was: a stored point_id, flags keyed by it, and its
    # points in the order files arrived, the northern tile's first.
    with open_store(env.store) as con:
        con.execute("ALTER TABLE lake.points ADD COLUMN point_id BLOB")
        con.execute("ALTER TABLE lake.points SET SORTED BY (file_id)")
        [(last,)] = con.execute("SELECT max(rowid) FROM lake.points").fetchall()
        con.execute("INSERT INTO lake.points SELECT * FROM lake.points")
        con.execute("DELETE FROM lake.points WHERE rowid <= ?", [last])
        con.execute("DROP TABLE lake.qc_flags")
        con.execute(
            """CREATE TABLE lake.qc_flags (point_id BLOB, flag VARCHAR, reason VARCHAR,
            qc_version INTEGER, cell_id SMALLINT)"""
        )
        con.execute("DELETE FROM lake.store_meta WHERE key IN ('layout', 'compacted')")
        con.execute(
            "UPDATE lake.store_meta SET value = ? WHERE key = 'hash'", [catalog.HASH_SCHEME]
        )
    # Reading it would find no flags until QC runs again, so a reader refuses it.
    with pytest.raises(RuntimeError, match="run `grid compact` first"):
        env.query("SELECT 1")
    with open_store(env.store) as con:
        # A build that keys points by a stored point_id checks the scheme alone: it refuses.
        assert con.execute("SELECT value FROM lake.store_meta WHERE key = 'hash'").fetchone() == (
            catalog.STORE_SCHEME,
        )
        assert "point_id" not in columns(con, "points")
        assert "tile_id" in columns(con, "qc_flags")
        # QC writes its flags again under the new key.
        assert con.execute("SELECT count(*) FROM lake.qc_batches").fetchone() == (0,)
        unsorted = [t for f in point_files(con) for t in f]
        assert unsorted != sorted(unsorted)
        assert catalog.compact(con) == 1
        assert catalog.compact(con) == 0
        files = point_files(con)
    assert len(files) == 1 and files[0] == sorted(files[0]) and len(set(files[0])) == 2
    assert (
        env.query('SELECT file_id, "row", tile_id, depth_raw FROM lake.points ORDER BY ALL')
        == before
    )


def test_ingest_writes_points_sorted_by_tile_and_merges_runs_sorted(env):  # noqa: F811
    env.noaa.put(noaa_key(1), noaa_csv(track(34.1)))
    env.run("noaa")
    # A later run's file, in a tile south of the first's: the publish merges the two.
    env.noaa.put(noaa_key(2), noaa_csv(track(33.1), unique_id="AQM-2"))
    env.run("noaa")
    with open_store(env.store, write=False) as con:
        files = point_files(con)
    assert len(files) == 1 and files[0] == sorted(files[0]) and len(files[0]) == 3000


def test_a_store_at_a_later_layout_is_refused(env):  # noqa: F811
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    env.run("noaa")
    with open_store(env.store) as con:
        con.execute("UPDATE lake.store_meta SET value = 'sorted-9' WHERE key = 'layout'")
    with pytest.raises(RuntimeError, match="layout sorted-9"), open_store(env.store):
        pass
