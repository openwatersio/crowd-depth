"""Stress the flush publish runs, for the race in DuckLake's flush of several tables at once.

Each worker inlines a row in many tables, flushes them all, and repeats. With the race,
most workers crash within a few hundred rounds on Linux; macOS's allocator hides it.
Not collected by pytest, since it takes minutes. Run it in the grid's image, where it
should pass, and with --unguarded, which runs the bare flush and should fail:

    ./docker.sh uv run --locked python tests/stress_flush.py [--unguarded]
"""

import multiprocessing
import sys
import tempfile

import duckdb

from grid.catalog import flush_inlined

TABLES, ROUNDS, WORKERS = 64, 300, 6


def worker(unguarded):
    with tempfile.TemporaryDirectory() as d:
        con = duckdb.connect()
        con.execute("INSTALL ducklake; LOAD ducklake")
        con.execute(
            f"ATTACH 'ducklake:{d}/c.ducklake' AS lake"
            f" (DATA_PATH '{d}/data/', DATA_INLINING_ROW_LIMIT 1000)"
        )
        for t in range(TABLES):
            con.execute(f"CREATE TABLE lake.t{t} (a INT)")
        for r in range(ROUNDS):
            con.execute("BEGIN")
            for t in range(TABLES):
                con.execute(f"INSERT INTO lake.t{t} VALUES ({r})")
            con.execute("COMMIT")
            if unguarded:
                con.execute("CALL ducklake_flush_inlined_data('lake')")
            else:
                flush_inlined(con)
        for t in range(TABLES):
            assert con.execute(f"SELECT count(*) FROM lake.t{t}").fetchone()[0] == ROUNDS


if __name__ == "__main__":
    unguarded = "--unguarded" in sys.argv[1:]
    con = duckdb.connect()
    con.execute("INSTALL ducklake; LOAD ducklake")
    (build,) = con.execute(
        "SELECT extension_version FROM duckdb_extensions() WHERE extension_name = 'ducklake'"
    ).fetchone()
    print(f"duckdb {duckdb.__version__}, ducklake {build}, unguarded={unguarded}")
    con.close()
    # Spawned, not forked: a fork copies this process's DuckDB mid-flight.
    spawn = multiprocessing.get_context("spawn")
    procs = [spawn.Process(target=worker, args=(unguarded,)) for _ in range(WORKERS)]
    for p in procs:
        p.start()
    for p in procs:
        p.join()
    codes = [p.exitcode for p in procs]
    print("worker exit codes:", codes)
    sys.exit(any(codes))
