"""Score surfaces on one tile's reference pixels inside a box, overall and by class, as
`grid benchmark` scores them: the Thimble Shoal Channel box by default.

    boxscore.py STORE OUT.json LABEL=SURFACE_DIR... [--tile T] [--box W,S,E,N]

The channel is the box's pixels whose reference is 12 m or deeper.
"""

import json
import sys
from pathlib import Path

import numpy as np

from grid import benchmark
from grid.catalog import open_store
from grid.objects import open_objects

# Both reads of the reference pixels in one order, so a box mask lines up with tile_pixels.
benchmark.TRUTH = benchmark.TRUTH.rstrip().rstrip(";") + "\nORDER BY py, px"
args = sys.argv[1:]
tile, box = 45463, (-76.175, 36.975, -76.14, 37.0)
if "--tile" in args:
    i = args.index("--tile")
    tile = int(args[i + 1])
    del args[i : i + 2]
if "--box" in args:
    i = args.index("--box")
    box = tuple(float(x) for x in args[i + 1].split(","))
    del args[i : i + 2]
store, out, runs = args[0], Path(args[1]), [a.split("=", 1) for a in args[2:]]
lat0, lon0 = tile // 360 - 90, tile % 360 - 180
result = {"tile": tile, "box": box, "runs": {}}
with open_store(open_objects(store), write=False) as con:
    for label, surface in runs:
        p = benchmark.tile_pixels(con, tile, surface, [], benchmark.QC_VERSION, False)
        # The same pixels, in the same order, as tile_pixels reads them.
        cols = benchmark.math.ceil(benchmark.BASE / benchmark.k_for(lat0) / benchmark.PIXEL_BASE)
        truth = con.execute(
            benchmark.TRUTH, {"tile": tile, "sources": [], "cols": cols}
        ).fetchnumpy()
        lat = lat0 + (truth["py"].astype(float) + 0.5) / benchmark.ROWS
        lon = lon0 + (truth["px"].astype(float) + 0.5) / cols
        inside = (lon >= box[0]) & (lon < box[2]) & (lat >= box[1]) & (lat < box[3])
        groups = benchmark.classes(p)
        masks = {
            "tile": np.ones(len(inside), bool),
            "box": inside,
            "box, channel (ref ≥ 12 m)": inside & (p["ref"] >= 12),
            "box, slope": inside & groups["slope"]["slope"],
            "box, held out": inside & groups["anchor"]["held out"],
            "box, interpolated": inside & groups["measured"]["interpolated"],
            "tile, held out": groups["anchor"]["held out"],
        }
        result["runs"][label] = {
            name: benchmark.score(
                p["surface"][m],
                p["ref"][m],
                p["shoalest"][m],
                p["surface_rough"][m],
                p["surface_sigma"][m],
            )
            for name, m in masks.items()
        }
out.write_text(json.dumps(result, indent=1) + "\n")
for label, r in result["runs"].items():
    for name, s in r.items():
        print(
            f"{label:8} {name:28} px {s['pixels']:>8} cov {s['coverage'] or 0:6.1%} bias {s['bias_m'] if s['bias_m'] is not None else float('nan'):6.2f} deep>1 {s['too_deep'] or 0:6.2%} fshoal>2 {s['false_shoal'] or 0:6.2%}"
        )
