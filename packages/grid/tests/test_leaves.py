import duckdb
import numpy as np
import rasterio
import test_grid
from test_ingest import env  # noqa: F401  (env is a fixture)
from test_tiles import NORTH, SOUTH, jobs, ran, track

from grid import leaves, tiles

STEPS = leaves.STEPS


def grid_with(*cells_):
    counts = np.zeros((STEPS, STEPS), dtype=np.int64)
    for r, c, n in cells_:
        counts[r, c] = n
    return counts


def test_a_sparse_tile_is_one_leaf():
    assert leaves.partition(SOUTH, None) == {leaves.ROOT: (0, STEPS, 0, STEPS)}
    small = grid_with((10, 10, leaves.SPLIT))
    assert list(leaves.partition(SOUTH, small)) == [leaves.ROOT]


def test_a_dense_tile_splits_until_each_leaf_holds_the_bound(monkeypatch):
    monkeypatch.setattr(leaves, "MIN_STEPS", 1)
    counts = grid_with((10, 10, 600_000), (11, 10, 600_000), (500, 500, 100_000))
    cut = leaves.partition(SOUTH, counts)
    # Leaves tile the whole tile, on whole steps, and none holds more than the bound unless
    # it is one step.
    area = np.zeros((STEPS, STEPS), dtype=int)
    for r0, r1, c0, c1 in cut.values():
        area[r0:r1, c0:c1] += 1
        n = counts[r0:r1, c0:c1].sum()
        assert n <= leaves.LEAF or (r1 - r0, c1 - c0) == (1, 1)
    assert (area == 1).all()
    assert len(cut) > 4


def test_no_leaf_splits_below_the_least_size():
    counts = grid_with((10, 10, 600_000), (11, 10, 600_000))
    cut = leaves.partition(SOUTH, counts)
    assert min(min(r1 - r0, c1 - c0) for r0, r1, c0, c1 in cut.values()) == leaves.MIN_STEPS


def test_leaves_merge_back_only_under_a_quarter_of_the_bound(monkeypatch):
    monkeypatch.setattr(leaves, "MIN_STEPS", 1)
    busy = grid_with((10, 10, 300_000), (400, 400, 900_000))
    cut = leaves.partition(SOUTH, busy)
    # A day's withdrawals take the tile under the split, but not under a quarter of it.
    quieter = grid_with((10, 10, 100_000), (400, 400, 200_000))
    assert leaves.partition(SOUTH, quieter, cut).keys() >= {k for k in cut if len(k) <= 2}
    assert list(leaves.partition(SOUTH, quieter)) == [leaves.ROOT]
    gone = grid_with((10, 10, 1000))
    assert list(leaves.partition(SOUTH, gone, cut)) == [leaves.ROOT]


def test_a_change_dirties_the_leaves_within_reach_alone():
    split = {SOUTH: {"r0": (0, 300, 0, 300), "r1": (0, 300, 300, 600)}}
    _, cols = leaves.reach(SOUTH, "cells")
    # A step just east of the first leaf's east edge, and one a reach past it.
    near = leaves.step_boxes([SOUTH], [10], [300])
    far = leaves.step_boxes([SOUTH], [10], [300 + -(-cols // leaves.STEP) + 1])
    assert leaves.dirty(split, near, "cells") == {SOUTH: ["r0", "r1"]}
    assert leaves.dirty(split, far, "cells") == {SOUTH: ["r1"]}
    # A change in a neighbor tile reaches the leaves by its edge.
    below = leaves.step_boxes([SOUTH - 360], [STEPS - 1], [10])
    assert leaves.dirty(split, below, "surface") == {SOUTH: ["r0"]}
    assert leaves.reach(SOUTH, "surface") > leaves.reach(SOUTH, "cells")


def crossing(env):  # noqa: F811
    """Two tracks along rows and one across them in the south tile, one in the north."""
    test_grid.put(env, 1, track(5000, 12.0), "A")
    test_grid.put(env, 2, track(5012, 12.0), "B")
    rows = [(i, *test_grid.at(4970 + i, 30), 11.0 + (i % 3) * 0.2) for i in range(70)]
    test_grid.put(env, 3, rows, "C")
    test_grid.put(env, 4, track(200, 20.0, lat_shift=1), "D")
    env.run("noaa")


def same_outputs(a, b, tile):
    con = duckdb.connect()
    for kind, order in (("cells", 'level, "row", col'), ("shoals", '"row", lon, lat'),
                        ("flags", "point_id, flag, reason")):  # fmt: skip
        got = [con.execute("FROM read_parquet(?) ORDER BY ALL", [str(r / tiles.TILE_FILES[kind].format(tile))]).fetchall() for r in (a, b)]  # fmt: skip
        assert got[0] == got[1], kind
    paths = [r / tiles.TILE_FILES["surface"].format(tile) for r in (a, b)]
    assert paths[0].exists() == paths[1].exists()
    if paths[0].exists():
        with rasterio.open(paths[0]) as x, rasterio.open(paths[1]) as y:
            assert np.array_equal(x.read(), y.read())


def test_leaves_build_what_whole_tiles_build(env, tmp_path, monkeypatch):  # noqa: F811
    crossing(env)
    whole = tmp_path / "whole"
    assert tiles.build(env.store, whole, cores=2, memory_mb=8192) == 0
    split = tmp_path / "split"
    monkeypatch.setattr(leaves, "SPLIT", 60)
    monkeypatch.setattr(leaves, "LEAF", 25)
    # Leaf edges down to a step, so the tracks cross them.
    monkeypatch.setattr(leaves, "MIN_STEPS", 1)
    assert tiles.build(env.store, split, cores=2, memory_mb=8192) == 0
    cut = tiles.partitions(split)[SOUTH]
    assert len(cut) > 4
    for t in (SOUTH, NORTH):
        same_outputs(whole, split, t)

    # A new track across one corner of the south tile's busy water: only the leaves within
    # reach rebuild, and the tile is still what a whole build makes.
    rows = [(i, *test_grid.at(5030, 40 + i), 13.0) for i in range(10)]
    test_grid.put(env, 5, rows, "E")
    env.run("noaa")
    seen = len(jobs(split))
    assert tiles.build(env.store, split, cores=2, memory_mb=8192) == 0
    again = ran(split, seen)
    rebuilt = {k.split("/")[1] for k in again["leaf_cells"] if k.startswith(f"{SOUTH}/")}
    assert rebuilt and rebuilt < set(tiles.partitions(split)[SOUTH])
    assert all(not k.startswith(f"{NORTH}/") for k in again["leaf_cells"])
    monkeypatch.undo()
    assert tiles.build(env.store, whole, cores=2, memory_mb=8192) == 0
    same_outputs(whole, split, SOUTH)
