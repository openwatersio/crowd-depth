"""Rebuild one tile's surface in RUN at another k, leaf by leaf, then splice it: the surface is
the blurred median less K σ, and σ and the shoal floor don't depend on K.

    ksweep.py RUN K [TILE]

RUN is a clone of a finished `grid tiles` run; its other files are left as they are.
Its fingerprints don't record the patch, so `grid tiles` would take the variant's files
as current: score the clone, and never build on it or publish from it.
"""

import sys
from pathlib import Path

from grid import statistic, tiles

run, k = Path(sys.argv[1]), float(sys.argv[2])
tile = int(sys.argv[3]) if len(sys.argv) > 3 else 45463
statistic.K = k
for leaf in tiles.partitions(run)[tile]:
    (tiles.leaf_dir(run, tile, leaf) / "surface.fp").unlink(missing_ok=True)
    print(leaf, tiles.do_leaf_surface(run, f"{tile}/{leaf}", 1), flush=True)
    # A stamp no build writes, so a leaf `grid tiles` ever reaches is built again at the real k.
    stamp = tiles.leaf_dir(run, tile, leaf) / "surface.fp"
    stamp.write_text(stamp.read_text() + f" k={k}")
tiles.do_surface(run, tile, 1)
print("done", tile, "k", k)
