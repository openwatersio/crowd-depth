import os

import duckdb
import pytest

from grid import reference


@pytest.fixture(autouse=True)
def own_cache(tmp_path, monkeypatch):
    """Each test gets its own download cache, never the machine's."""
    monkeypatch.setenv("GRID_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(reference, "uncached", {})


@pytest.fixture(autouse=True)
def one_thread_per_worker(monkeypatch):
    """Under pytest-xdist the workers share the cores, so DuckDB takes one thread each."""
    if "PYTEST_XDIST_WORKER" not in os.environ:
        return
    connect = duckdb.connect
    monkeypatch.setattr(duckdb, "connect", lambda *a, **k: connect(*a, config={"threads": 1}, **k))
