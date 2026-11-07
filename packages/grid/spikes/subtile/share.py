"""Soundings a day's leaf jobs reread, over the last 30 arrival days, from a leaf run's
partition and the package's own dirty test (leaves.dirty).

    share.py RUN OUT.json

Each day's changes are that day's arrivals: the steps their soundings fall in. A dirty leaf's
cells read its own tile's soundings within the cells' reach of it, its surface every tile's
within the surface's reach. Shares are of all active soundings, summed over jobs (what the
jobs read, halos read twice where they overlap). The 1° figures are today's: a tile's cells
when it has arrivals, its surface when it or a neighbor does.
"""

import json
import math
import os
import sys
from pathlib import Path

import numpy as np

from grid import leaves, tiles

run = Path(sys.argv[1])
split = tiles.partitions(run)
# MIN_STEPS=n: partition again, leaves at least n steps a side.
if os.environ.get("MIN_STEPS"):
    leaves.MIN_STEPS = int(os.environ["MIN_STEPS"])
boxes = {t: {k: v[:4] for k, v in ls.items()} for t, ls in split.items()}
with tiles.snapshot(run, "lake") as con:
    con.execute(
        f"""CREATE TEMP TABLE steps AS
        SELECT p.tile_id, {tiles.BASE_ROW} // {leaves.STEP} AS sr, {tiles.COLUMN} // {leaves.STEP} AS sc,
          f.arrival::DATE AS day, count(*) AS n
        FROM lake.points p JOIN lake.files f USING (file_id) WHERE f.status = 'active'
        GROUP BY ALL"""
    )
    days = [
        d
        for (d,) in con.execute(
            "SELECT DISTINCT day FROM steps ORDER BY 1 DESC LIMIT 30"
        ).fetchall()
    ]
    every = con.execute("SELECT tile_id, sr, sc, sum(n) AS n FROM steps GROUP BY ALL").fetchnumpy()
    arrivals = {
        d: con.execute("SELECT DISTINCT tile_id, sr, sc FROM steps WHERE day = ?", [d]).fetchnumpy()
        for d in days
    }

if os.environ.get("MIN_STEPS"):
    for t in split:
        if len(split[t]) > 1:
            at = every["tile_id"] == t
            grid = np.zeros(leaves.shape(t), dtype=np.int64)
            np.add.at(grid, (every["sr"][at], every["sc"][at]), every["n"][at])
            split[t] = {k: list(v) for k, v in leaves.partition(t, grid).items()}
boxes = {t: {k: v[:4] for k, v in ls.items()} for t, ls in split.items()}

# Summed-area tables of soundings per step, per tile.
sat, total = {}, int(every["n"].sum())
per_tile = {}
for t in np.unique(every["tile_id"]):
    t = int(t)
    rows, cols = leaves.STEPS, leaves.shape(t)[1] or 1
    grid = np.zeros((rows + 1, cols + 1), dtype=np.int64)
    at = every["tile_id"] == t
    np.add.at(
        grid, (every["sr"][at] + 1, np.minimum(every["sc"][at], cols - 1) + 1), every["n"][at]
    )
    sat[t] = grid.cumsum(0).cumsum(1)
    per_tile[t] = int(every["n"][at].sum())


def steps_of(t, s, n, w, e):
    """The steps (first row, end row, first column, end column) of tile t a box in degrees
    touches."""
    g = sat[t]
    lat0, lon0 = t // 360 - 90, t % 360 - 180
    k = leaves.k_for(lat0)
    rows, cols = g.shape[0] - 1, g.shape[1] - 1
    r0 = min(max(math.floor((s - lat0) * leaves.STEPS), 0), rows)
    r1 = min(max(math.ceil((n - lat0) * leaves.STEPS), 0), rows)
    c0 = min(max(math.floor((w - lon0) * leaves.BASE / k / leaves.STEP), 0), cols)
    c1 = min(max(math.ceil((e - lon0) * leaves.BASE / k / leaves.STEP), 0), cols)
    return r0, r1, c0, c1


def within(t, *box):
    """Soundings of tile t in the steps a box in degrees touches."""
    if t not in sat:
        return 0
    g = sat[t]
    r0, r1, c0, c1 = steps_of(t, *box)
    return int(g[r1, c1] - g[r0, c1] - g[r1, c0] + g[r0, c0])


out = []
for d in days:
    a = arrivals[d]
    changes = leaves.step_boxes(a["tile_id"], a["sr"], a["sc"])
    day = {"day": str(d)}
    for stage in ("cells", "surface"):
        hit = leaves.dirty(boxes, changes, stage)
        read, union = 0, {}
        for t, keys in hit.items():
            for k in keys:
                box = leaves.degrees(t, boxes[t][k], leaves.reach(t, stage))
                around = [t] if stage == "cells" else tiles.neighbors(t)
                for n in around:
                    if n in sat:
                        read += within(n, *box)
                        r0, r1, c0, c1 = steps_of(n, *box)
                        union.setdefault(n, np.zeros(np.array(sat[n].shape) - 1, bool))[
                            r0:r1, c0:c1
                        ] = True
        # Each sounding read once, however many jobs read it: what the design doc counted.
        once = sum(int(np.diff(np.diff(sat[n], axis=0), axis=1)[m].sum()) for n, m in union.items())
        day[stage] = {
            "leaves": sum(map(len, hit.values())),
            "share": read / total,
            "union": once / total,
        }
    touched = set(np.unique(a["tile_id"]).tolist())
    near = {n for t in touched for n in tiles.neighbors(t)} & set(per_tile)
    day["tile_cells"] = sum(per_tile[t] for t in touched) / total
    day["tile_surface"] = sum(per_tile[t] for t in near) / total
    out.append(day)
    print(json.dumps(day), flush=True)

summary = {
    key: float(np.median([d[key]["share"] if isinstance(d[key], dict) else d[key] for d in out]))
    for key in ("cells", "surface", "tile_cells", "tile_surface")
}
summary["union"] = {
    key: float(np.median([d[key]["union"] for d in out])) for key in ("cells", "surface")
}
summary["range"] = {
    key: [min(d[key]["share"] for d in out), max(d[key]["share"] for d in out)]
    for key in ("cells", "surface")
}
summary["leaves"] = sum(map(len, split.values()))
print(json.dumps(summary))
Path(sys.argv[2]).write_text(json.dumps({"days": out, "summary": summary}, indent=1))
