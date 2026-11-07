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
    # A change in a neighbor tile reaches the surfaces of the leaves by its edge, but not
    # their cells, which read their own tile alone.
    below = leaves.step_boxes([SOUTH - 360], [STEPS - 1], [10])
    assert leaves.dirty(split, below, "surface", [SOUTH - 360]) == {SOUTH: ["r0"]}
    assert leaves.dirty(split, below, "cells", [SOUTH - 360]) == {}
    assert leaves.reach(SOUTH, "surface") > leaves.reach(SOUTH, "cells")


def test_a_surface_reaches_as_far_as_a_wider_neighbors_flags():
    # 47°N has columns of one base step and 48°N of two: a flag north of the line reads
    # twice as far in degrees.
    south, north = (47 + 90) * 360 + 180, (48 + 90) * 360 + 180
    assert (
        leaves.reach(south, "surface")[1] - leaves.reach(south, "cells")[1] > 2 * leaves.FLAGS_ROWS
    )
    assert leaves.reach(south, "surface")[0] == leaves.reach(north, "surface")[0]


def test_a_change_across_the_antimeridian_reaches_the_leaves_beside_it():
    west = (33 + 90) * 360  # 33°N, 180°W
    east = west + 359  # 33°N, 179°E
    split = {west: {"r0": (0, 600, 0, 300), "r1": (0, 600, 300, 600)}}
    change = leaves.step_boxes([east], [300], [599])
    assert leaves.dirty(split, change, "surface", [east]) == {west: ["r0"]}
    # Its leaf's read takes the neighbor's points across the line, and no farther ones.
    sql = tiles.within(west, (0, 600, 0, 300), "surface")
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE p AS SELECT 33.5 AS lat, unnest([179.995, 179.5, -179.995, -179.0])::DOUBLE AS lon"
    )
    assert sorted(x for (x,) in con.execute(f"SELECT lon FROM p WHERE {sql}").fetchall()) == [
        -179.995,
        179.995,
    ]
    # A tile at the east end reads the one across it the same way, and its own leaf.
    sql = tiles.within(east, (0, 600, 300, 600), "surface")
    assert sorted(x for (x,) in con.execute(f"SELECT lon FROM p WHERE {sql}").fetchall()) == [
        -179.995,
        179.5,
        179.995,
    ]


def test_a_tile_that_doesnt_divide_into_steps_is_one_leaf_across_it():
    polar = (86 + 90) * 360 + 180  # 86°N, 0°E, where k doesn't divide its columns
    assert leaves.shape(polar)[1] is None
    cut = leaves.partition(polar, None)
    middle = leaves.step_boxes([polar], [300], [0]) + [0, 0, 0.5, 0.5]
    assert leaves.dirty({polar: cut}, middle, "cells", [polar]) == {polar: [leaves.ROOT]}


def crossing(env):  # noqa: F811
    """Two tracks along rows and one across them in the south tile, two in the north."""
    test_grid.put(env, 1, track(5000, 12.0), "A")
    test_grid.put(env, 2, track(5012, 12.0), "B")
    rows = [(i, *test_grid.at(4970 + i, 30), 11.0 + (i % 3) * 0.2) for i in range(70)]
    test_grid.put(env, 3, rows, "C")
    test_grid.put(env, 4, track(200, 20.0, lat_shift=1), "D")
    # Just across the north edge: the band beside it reaches leaves of the south tile that
    # hold no soundings of their own.
    test_grid.put(env, 6, track(1, 15.0, lat_shift=1), "F")
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

    # Leaves an older build left of a tile that is no longer live are removed.
    for d in ("leaves/12345/r0", "fp/12345"):
        (split / d).mkdir(parents=True)
    monkeypatch.setattr(leaves, "SPLIT", 60)
    monkeypatch.setattr(leaves, "LEAF", 25)
    monkeypatch.setattr(leaves, "MIN_STEPS", 1)
    tiles.prepare(env.store, split)
    assert not (split / "leaves/12345").exists() and not (split / "fp/12345").exists()
