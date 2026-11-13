import os
import threading

import pytest

from grid import reference


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
