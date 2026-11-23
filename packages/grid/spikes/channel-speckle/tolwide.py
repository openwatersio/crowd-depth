"""Rebuild every leaf's cells in RUN with the candidate-shoal tolerance widened to
max(2 m + 5% of the cell's median, 3 x MAD), the consensus check's, then count unconfirmed
cell shoals. Rejects on the deep side keep max(1 m, 3 x MAD).

    tolwide.py RUN PROCESSES

RUN is a clone of a finished `grid tiles` run; its cells, shoals and flags are rewritten.
Its fingerprints don't record the patch, so `grid tiles` would take the variant's files
as current: score the clone, and never build on it or publish from it.
Run `tolwide.py RUN 0` to count a run's cell shoals without rebuilding it.
"""

import multiprocessing
import sys
from collections import Counter
from pathlib import Path

import duckdb

from grid import cells, tiles

run, processes = Path(sys.argv[1]), int(sys.argv[2])
old = "WHEN r.med IS NULL OR k.d < r.med - r.bound THEN 'shoal'"
assert cells.CLASSIFY.count(old) == 1
cells.CLASSIFY = cells.CLASSIFY.replace(
    old, "WHEN r.med IS NULL OR k.d < r.med - greatest(r.bound, 2 + 0.05 * r.med) THEN 'shoal'"
)
split = tiles.partitions(run)
counts = tiles.counts(run)
keys = sorted(
    (f"{t}/{leaf}" for t, ls in split.items() for leaf in ls),
    key=lambda k: -counts[int(k.split("/")[0])],
)


def leaf(key):
    tiles.do_leaf_cells(run, key, 1)


def tile(t):
    tiles.do_cells(run, t, 1)


def size(t):
    n = counts.get(t, 0)
    return "under 100k" if n < 1e5 else "100k-1M" if n < 1e6 else "1M or more"


if __name__ == "__main__":
    if processes:
        ctx = multiprocessing.get_context("fork")
        with ctx.Pool(processes, maxtasksperchild=1) as pool:
            pool.map(leaf, keys, chunksize=1)
            pool.map(tile, sorted(split), chunksize=1)
    found = Counter()
    for t, flag, n in duckdb.sql(
        f"""SELECT tile_id, flag, count(*) FROM read_parquet('{run}/flags/*.parquet')
        WHERE reason = 'cell_shoal' GROUP BY ALL"""
    ).fetchall():
        found[(size(t), flag)] += n
    for key, n in sorted(found.items()):
        print(*key, n)
