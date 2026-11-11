import itertools

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


def test_compact_rewrites_a_partition_a_range_at_a_time(env, monkeypatch):  # noqa: F811
    # Three tiles of 3,000 soundings, each heading north, and one more in the first tile;
    # each band more than DuckLake inlines.
    for n, lat in enumerate((34.1, 33.1, 32.1), 1):
        rows = [(i // 60, -78.1 + i * 1e-5, lat + i * 1e-5, 5.0) for i in range(3000)]
        env.noaa.put(noaa_key(n), noaa_csv(rows, unique_id=f"AQM-{n}"))
    env.noaa.put(noaa_key(4), noaa_csv(track(32.2, n=200), unique_id="AQM-4"))
    env.run("noaa")
    before = env.query('SELECT file_id, "row", tile_id, depth_raw FROM lake.points ORDER BY ALL')
    # A tile of more than COMPACT_ROWS is cut into bands of latitude, the others whole.
    monkeypatch.setattr(catalog, "COMPACT_ROWS", 2000)
    with open_store(env.store) as con:
        con.execute("DELETE FROM lake.store_meta WHERE key = 'compacted'")
        [(cell,)] = con.execute("SELECT DISTINCT cell_id FROM lake.points").fetchall()
        ranges = catalog.compact_ranges(con, cell)
        assert catalog.compact(con) == 1
        assert catalog.compact(con) == 0
        files = [
            con.execute(f"SELECT tile_id, lat, lon FROM read_parquet('{f}')").fetchall()
            for (f,) in con.execute(
                "SELECT data_file FROM ducklake_list_files('lake', 'points')"
            ).fetchall()
        ]
    assert len(ranges) == 6 and [len({t for t, *_ in f}) for f in files] == [1] * 6
    # Each file in order, and no two overlap.
    assert all(f == sorted(f) for f in files)
    spans = sorted((f[0], f[-1]) for f in files)
    assert all(a[1] < b[0] for a, b in itertools.pairwise(spans))
    assert (
        env.query('SELECT file_id, "row", tile_id, depth_raw FROM lake.points ORDER BY ALL')
        == before
    )


def test_a_compact_stopped_partway_leaves_the_store_as_it_was(env, monkeypatch):  # noqa: F811
    for n, lat in enumerate((34.1, 33.1), 1):
        env.noaa.put(noaa_key(n), noaa_csv(track(lat), unique_id=f"AQM-{n}"))
    env.run("noaa")
    query = 'SELECT file_id, "row", tile_id, depth_raw FROM lake.points ORDER BY ALL'
    before = env.query(query)
    monkeypatch.setattr(catalog, "COMPACT_ROWS", 1)
    with open_store(env.store) as con:
        con.execute("DELETE FROM lake.store_meta WHERE key = 'compacted'")
    real = catalog.log.info

    def stop(msg, *args):
        # After the first range is written and committed, before any old point is deleted.
        if msg.startswith("compacted partition %s %s tiles"):
            raise KeyboardInterrupt
        real(msg, *args)

    monkeypatch.setattr(catalog.log, "info", stop)
    with pytest.raises(KeyboardInterrupt), open_store(env.store) as con:
        catalog.compact(con, con.publish)
    assert env.query(query) == before
    monkeypatch.setattr(catalog.log, "info", real)
    with open_store(env.store) as con:
        assert catalog.compact(con, con.publish) == 1
    assert env.query(query) == before


def test_runs_write_sorted_files_that_compact_merges_once_crowded(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(catalog, "COMPACT_FILES", 2)
    for n, lat in enumerate((34.1, 33.1), 1):
        env.noaa.put(noaa_key(n), noaa_csv(track(lat), unique_id=f"AQM-{n}"))
        env.run("noaa")
    query = 'SELECT file_id, "row", tile_id, depth_raw FROM lake.points ORDER BY ALL'
    flags = "SELECT * FROM lake.qc_flags ORDER BY ALL"
    before = env.query(query)

    def listed(con, table):
        return con.execute(
            f"SELECT data_file, delete_file FROM ducklake_list_files('lake', '{table}')"
        ).fetchall()

    with open_store(env.store) as con:
        # Each run's points stay in a sorted file of their own until compact.
        files = point_files(con)
        assert len(files) == 2 and all(f == sorted(f) for f in files)
        assert catalog.compact(con, con.publish) == 1
        points = listed(con, "points")
        # A file of flags for each file's points: one small file, then two, which crowd the
        # flags alone, so their points stay as they are.
        for (file_id,) in con.execute("SELECT file_id FROM lake.files").fetchall():
            assert catalog.compact(con, con.publish) == 0
            con.execute(
                f"""INSERT INTO lake.qc_flags SELECT {catalog.POINT_ID}, 'reject', 'spike', 99,
                cell_id, tile_id FROM lake.points p WHERE file_id = ?""",
                [file_id],
            )
        assert catalog.compact(con, con.publish) == 1
        assert listed(con, "points") == points and len(listed(con, "qc_flags")) == 1
        # A delete leaves a file with deletes, which counts toward a rewrite too; a tile of
        # more flags than COMPACT_ROWS is cut into bands of point_id.
        monkeypatch.setattr(catalog, "COMPACT_FILES", 1)
        monkeypatch.setattr(catalog, "COMPACT_ROWS", 1000)
        con.execute(
            "DELETE FROM lake.qc_flags WHERE tile_id = (SELECT min(tile_id) FROM lake.qc_flags)"
        )
        assert listed(con, "qc_flags")[0][1]
        flagged = con.execute(flags).fetchall()
        [(cell,)] = con.execute("SELECT DISTINCT cell_id FROM lake.qc_flags").fetchall()
        bands = catalog.compact_ranges(con, cell, "qc_flags")
        assert len(bands) > len({lo for lo, *_ in bands})
        assert catalog.compact(con, con.publish) == 1
        # At full-size ranges, what compact writes doesn't crowd a partition again.
        monkeypatch.setattr(catalog, "COMPACT_FILES", 2)
        monkeypatch.setattr(catalog, "COMPACT_ROWS", 20_000_000)
        catalog.compact(con, con.publish)
        assert catalog.compact(con, con.publish) == 0
        [(_, deletes)] = listed(con, "qc_flags")
        files = point_files(con)
    assert deletes is None and 0 < len(flagged) < 3000
    assert all(f == sorted(f) for f in files) and sum(map(len, files)) == 3000
    assert env.query(query) == before and env.query(flags) == flagged


def test_compact_counts_flags_still_inlined(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(catalog, "COMPACT_FILES", 2)
    env.noaa.put(noaa_key(1), noaa_csv(track(34.1)))
    env.run("noaa")
    insert = f"""INSERT INTO lake.qc_flags SELECT {catalog.POINT_ID}, 'reject', 'spike', 99,
        cell_id, tile_id FROM lake.points p WHERE "row" BETWEEN ? AND ?"""
    with open_store(env.store) as con:
        assert catalog.compact(con, con.publish) == 1
        # A file of flags, then a QC batch too small to leave the catalog until a flush.
        con.execute(insert, [0, 1489])
        con.execute(insert, [1490, 1499])
        assert catalog.compact(con, con.publish) == 1


def test_a_store_at_a_later_layout_is_refused(env):  # noqa: F811
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    env.run("noaa")
    with open_store(env.store) as con:
        con.execute("UPDATE lake.store_meta SET value = 'sorted-9' WHERE key = 'layout'")
    with pytest.raises(RuntimeError, match="layout sorted-9"), open_store(env.store):
        pass


def test_a_store_of_another_hash_scheme_is_refused_before_it_migrates(env):  # noqa: F811
    env.noaa.put(noaa_key(1), noaa_csv(ROWS))
    env.run("noaa")
    with open_store(env.store) as con:
        con.execute("ALTER TABLE lake.points ADD COLUMN point_id BLOB")
        con.execute("DELETE FROM lake.store_meta WHERE key = 'layout'")
        con.execute("UPDATE lake.store_meta SET value = 'md5-sum-1' WHERE key = 'hash'")

    def catalogs():
        # Every catalog and the pointer; the lock changes hands on any write open.
        return sorted(
            (o.key, o.etag) for o in env.store.list("catalog/")[0] if o.key != "catalog/lock"
        )

    before = catalogs()
    # The scheme is checked before the layout, by readers and writers alike.
    with pytest.raises(RuntimeError, match="hashes with md5-sum-1"):
        env.query("SELECT 1")
    with pytest.raises(RuntimeError, match="hashes with md5-sum-1"), open_store(env.store):
        pass
    # Nothing published: the store is as its own build left it.
    assert catalogs() == before
