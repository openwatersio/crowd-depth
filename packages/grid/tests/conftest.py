import os
import threading
import zlib

import numpy as np
import pytest
import rasterio

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


def heights(path, z, bounds=(-180, -90, 180, 90)):
    """A raster of heights `z` (rows north to south) over `bounds`, as GEBCO's are."""
    z = np.asarray(z, np.int16)
    transform = rasterio.transform.from_bounds(*bounds, z.shape[1], z.shape[0])
    with rasterio.open(
        path, "w", driver="GTiff", width=z.shape[1], height=z.shape[0], count=1,
        dtype="int16", crs="EPSG:4326", transform=transform,
    ) as dst:  # fmt: skip
        dst.write(z, 1)
    return path


@pytest.fixture(scope="session")
def sea_level(tmp_path_factory):
    """A deep-water reference with no deep water, so no test downloads GEBCO."""
    return heights(tmp_path_factory.mktemp("deep") / "flat.tif", [[0]])


@pytest.fixture(autouse=True)
def own_cache(tmp_path, monkeypatch, sea_level):
    """Each test gets its own download cache, never the machine's."""
    monkeypatch.setenv("GRID_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("GRID_DEEP_REFERENCE", str(sea_level))
    monkeypatch.setattr(reference, "uncached", {})
    monkeypatch.setattr(reference, "stopping", threading.Event())


if "PYTEST_XDIST_WORKER" in os.environ:
    # After grid's import: it sets the allocator's config, which DuckDB reads once on loading.
    import duckdb

    # The workers share the cores, so DuckDB takes two threads each rather than all of them.
    # Two, not one: production runs DuckDB multi-threaded, and so should these tests.
    connect = duckdb.connect
    duckdb.connect = lambda *a, config={}, **k: connect(*a, config={"threads": 2, **config}, **k)
