import os
import threading
import zlib

import pytest

from grid import reference


def pytest_addoption(parser):
    parser.addoption("--shard", help="I/N: run the Ith of N shares of the tests, as CI's jobs do")


def pytest_collection_modifyitems(config, items):
    if shard := config.getoption("shard"):
        i, n = map(int, shard.split("/"))
        if not 1 <= i <= n:
            raise pytest.UsageError(f"--shard {shard}: I must be 1 to N")
        # By a hash of each test's id, so a new test lands in a share without being listed.
        mine = [t for t in items if zlib.crc32(t.nodeid.encode()) % n == i - 1]
        config.hook.pytest_deselected(items=[t for t in items if t not in mine])
        items[:] = mine


@pytest.fixture(autouse=True)
def own_cache(tmp_path, monkeypatch):
    """Each test gets its own download cache, never the machine's."""
    monkeypatch.setenv("GRID_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(reference, "uncached", {})
    monkeypatch.setattr(reference, "stopping", threading.Event())


if "PYTEST_XDIST_WORKER" in os.environ:
    # After grid's import: it sets the allocator's config, which DuckDB reads once on loading.
    import duckdb

    # The workers share the cores, so DuckDB takes two threads each rather than all of them.
    # Two, not one: production runs DuckDB multi-threaded, and so should these tests.
    connect = duckdb.connect
    duckdb.connect = lambda *a, config={}, **k: connect(*a, config={"threads": 2, **config}, **k)
