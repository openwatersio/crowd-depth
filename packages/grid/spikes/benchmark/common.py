"""Score two surfaces on the same reference pixels: those both cover, and those only one covers.

    common.py STORE RUN_A RUN_B [SOURCE...]

Run with the grid package from the checkout B was built with. Shares are as `grid benchmark`
counts them: more than 1 m deeper than the reference's shoalest, and more than 2 m shoaler than
the reference. The last line counts the pixels only B covers that B's `near` band (the band
beside a lone track, band 5) drew.
"""

import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import rasterio

from grid import benchmark as bm
from grid.catalog import open_store
from grid.cells import k_for
from grid.objects import open_objects
from grid.surface import ROWS

store, A, B = sys.argv[1:4]
sources = sys.argv[4:]


def read(run, tile, lon0, lat0, cols, at, n):
    """A run's depth and near band at the reference pixels, NaN and False where it has no
    surface; a COG off the tile's pixel grid is refused, as `grid benchmark` refuses it."""
    path = Path(run) / "surface" / f"{tile}.tif"
    if not path.exists():
        return np.full(n, np.nan), np.zeros(n, bool)
    with rasterio.open(path) as s:
        if not bm.on_grid(s, lon0, lat0, cols):
            raise ValueError(f"{path} is not on tile {tile}'s surface pixel grid")
        d = s.read(1)[at]
        near = s.read(5)[at] == 1 if s.count >= 5 else np.zeros(n, bool)
    d[d == bm.NODATA] = np.nan
    return d, near


def surfaces(run):
    return {int(p.stem) for p in (Path(run) / "surface").glob("*.tif") if p.stem.isdigit()}


near = np.zeros(2)
tot = defaultdict(
    lambda: np.zeros(5)
)  # pixels, A too deep, A false shoal, B too deep, B false shoal
tiles = sorted(surfaces(A) | surfaces(B))
with open_store(open_objects(store), write=False) as con:
    for t in tiles:
        lat0, lon0 = t // 360 - 90, t % 360 - 180
        cols = math.ceil(bm.BASE / k_for(lat0) / bm.PIXEL_BASE)
        tr = con.execute(bm.TRUTH, {"tile": t, "sources": sources, "cols": cols}).fetchnumpy()
        if not len(tr["py"]):
            continue
        at = (ROWS - 1 - tr["py"].astype(np.int64), tr["px"].astype(np.int64))
        ref = bm.floats(tr, "depth")
        shoalest = ref - bm.floats(tr, "relief")
        a, _ = read(A, t, lon0, lat0, cols, at, len(ref))
        b, nb = read(B, t, lon0, lat0, cols, at, len(ref))
        ha, hb = ~np.isnan(a), ~np.isnan(b)
        near += [(~ha & hb).sum(), (~ha & hb & nb).sum()]
        for name, m in (
            ("both", ha & hb),
            ("A only", ha & ~hb),
            ("B only", ~ha & hb),
            ("neither", ~ha & ~hb),
        ):
            x = tot[name]
            x[0] += m.sum()
            x[1] += (a[m] > shoalest[m] + 1).sum()
            x[2] += (a[m] < ref[m] - 2).sum()
            x[3] += (b[m] > shoalest[m] + 1).sum()
            x[4] += (b[m] < ref[m] - 2).sum()
n = sum(x[0] for x in tot.values())
print(f"{A} vs {B}, {len(tiles)} tiles, references {sources or 'all'}, {n:,.0f} pixels")
for name, x in tot.items():
    p = max(x[0], 1)
    print(
        f"{name:8} {x[0]:>10,.0f} ({x[0] / n:.1%})  A: too deep {x[1] / p:.2%} false shoal {x[2] / p:.2%}   B: too deep {x[3] / p:.2%} false shoal {x[4] / p:.2%}"
    )
print(
    f"B only from the near band: {near[1]:,.0f} of {near[0]:,.0f} ({near[1] / max(near[0], 1):.1%})"
)
