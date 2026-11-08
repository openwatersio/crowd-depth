"""Rebuild every tile's cells and surface whole under another rule for σ's fallback, for the
benchmark: `neutral` takes, among equally near pixels within FALLBACK_PX, the one with the
least row and then column; `kdtree` is the rule before it, the nearest pixel at any distance,
ties as the k-d tree finds them.

    variant.py WHOLE_RUN OUT neutral|kdtree [PROCESSES]

WHOLE_RUN is a `grid tiles` run whose tiles are each one leaf; OUT gets its catalog and
partition, and the cells, shoals, flags and surface of every tile.
"""

import multiprocessing
import shutil
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from grid import leaves, statistic, tiles

src, out, rule = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
processes = int(sys.argv[4]) if len(sys.argv) > 4 else 8


def kdtree(x, y, values, default=np.nan):
    have = ~np.isnan(values)
    if not have.any():
        return lambda qx, qy: np.full(len(qx), default)
    tree = cKDTree(np.stack([x[have], y[have]], axis=1))
    taken = values[have]
    return lambda qx, qy: taken[tree.query(np.stack([qx, qy], axis=1))[1]]


def neutral(x, y, values, default=np.nan):
    have = ~np.isnan(values)
    if not have.any():
        return lambda qx, qy: np.full(len(qx), default)
    pts = np.stack([x[have], y[have]], axis=1)
    tree = cKDTree(pts)
    taken = np.append(values[have], np.nan)
    # Rank of each point by (row, column), and one past them for a missing neighbor.
    rank = np.append(np.lexsort((pts[:, 0], pts[:, 1])).argsort(), len(pts))

    def at(qx, qy):
        q = np.stack([np.asarray(qx), np.asarray(qy)], axis=1)
        d, i = tree.query(q, k=statistic.TIES, distance_upper_bound=statistic.FALLBACK_PX)
        r = np.where(d == d[:, :1], rank[i], len(pts) + 1)
        pick = i[np.arange(len(q)), r.argmin(axis=1)]
        return np.where(np.isfinite(d[:, 0]), taken[pick], default)

    return at


statistic.nearest = {"kdtree": kdtree, "neutral": neutral}[rule]

out.mkdir(parents=True, exist_ok=True)
for name in ("data_url", "snapshot.ducklake", "tiles.txt", "credits.txt"):
    shutil.copyfile(src / name, out / name)
(out / tiles.BASELINE).mkdir(exist_ok=True)
shutil.copyfile(src / tiles.BASELINE / "partitions.json", out / tiles.BASELINE / "partitions.json")
split = tiles.partitions(out)
assert all(list(ls) == [leaves.ROOT] for ls in split.values()), "WHOLE_RUN must be one leaf a tile"
for t in split:
    fp = out / "fp" / str(t) / f"{leaves.ROOT}.surface"
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(rule)
order = sorted(split, key=lambda t: -tiles.counts(out)[t])


def cells(t):
    tiles.do_leaf_cells(out, f"{t}/{leaves.ROOT}", 2)
    tiles.do_cells(out, t, 1)


def surface(t):
    tiles.do_leaf_surface(out, f"{t}/{leaves.ROOT}", 1)
    tiles.do_surface(out, t, 1)


if __name__ == "__main__":
    ctx = multiprocessing.get_context("fork")
    with ctx.Pool(processes, maxtasksperchild=1) as pool:
        pool.map(cells, order, chunksize=1)
        pool.map(surface, order, chunksize=1)
    print("done", rule, len(order))
