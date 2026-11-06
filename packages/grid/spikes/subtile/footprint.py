"""Dirty work per arrival day under sub-tile schemes, from soundings counts on a fine grid.

Fine grid: 1/512° (about 217 m of latitude). A unit is dirty when a new sounding lies within
REACH degrees of it (REACH / cos(lat) east–west), and rebuilding it reads it plus the same
REACH around it, across tile edges: what a unit reads is what can change it.

    REACH=0.007 footprint.py RUN OUT.json   # cells
    REACH=0.009 footprint.py RUN OUT.json   # surfaces

For windows and leaves the `cells` and `surface` columns of one run are equal. For the 1°
scheme, `cells` counts only tiles with arrivals, as today's pipeline does, and `surface` their
neighbors too; the bands scheme has only `cells`.
"""

import json
import math
import os
import sys
from pathlib import Path

import numpy as np

from grid import tiles as tilejobs

F = 512  # fine cells per degree
REACH = float(os.environ.get("REACH", "0.007"))  # degrees of latitude
DENSE = 1_000_000  # tiles below this rebuild whole

with tilejobs.snapshot(Path(sys.argv[1]), "lake") as con:
    con.execute(f"""CREATE TEMP TABLE fine AS
      SELECT p.tile_id, least(floor((lat-(p.tile_id//360-90))*{F}),{F - 1})::INT AS fy,
        least(floor((lon-(p.tile_id%360-180))*{F}),{F - 1})::INT AS fx,
        least(floor((lat-(p.tile_id//360-90))*10800),10799)::INT // 9 AS band,
        f.arrival::DATE AS day, count(*) AS n
      FROM lake.points p JOIN lake.files f USING (file_id) WHERE f.status='active' GROUP BY ALL""")
    days = [
        d
        for (d,) in con.execute("SELECT DISTINCT day FROM fine ORDER BY 1 DESC LIMIT 30").fetchall()
    ]
    allc = con.execute("SELECT tile_id, fy, fx, sum(n) FROM fine GROUP BY ALL").fetchnumpy()
    bands = con.execute("SELECT tile_id, band, sum(n) FROM fine GROUP BY ALL").fetchnumpy()
    newc = {
        d: con.execute(
            "SELECT tile_id, fy, fx, band, sum(n) FROM fine WHERE day=? GROUP BY ALL", [d]
        ).fetchnumpy()
        for d in days
    }

tiles = {}
for t, y, x, n in zip(*[allc[k] for k in allc]):
    tiles.setdefault(int(t), np.zeros((F, F), np.int64))[y, x] += n
band_n = {}
for t, b, n in zip(*[bands[k] for k in bands]):
    band_n.setdefault(int(t), np.zeros(1200, np.int64))[b] = n
total = sum(int(g.sum()) for g in tiles.values())


def dilate(mask, ry, rx):
    from scipy.ndimage import binary_dilation

    return binary_dilation(mask, np.ones((2 * ry + 1, 2 * rx + 1), bool))


def reach(t):
    """REACH in fine cells (rows, columns) at tile t's latitude."""
    lat = t // 360 - 90 + 0.5
    return math.ceil(REACH * F), math.ceil(REACH / math.cos(math.radians(lat)) * F)


def neighbors(t):
    return tilejobs.neighbors(t)


def offset(t, dy, dx):
    """The tile dy north and dx east of t, across the antimeridian; None past a pole."""
    lat, lon = t // 360 - 90 + dy, (t % 360 - 180 + dx + 180) % 360 - 180
    return (lat + 90) * 360 + lon + 180 if -90 <= lat <= 89 else None


def quadtree(g, n):
    """Leaf id per fine cell, splitting while a square holds more than n."""
    leaf = np.zeros_like(g, dtype=np.int64)
    nxt = [0]

    def split(y0, x0, s):
        if s == 1 or g[y0 : y0 + s, x0 : x0 + s].sum() <= n:
            leaf[y0 : y0 + s, x0 : x0 + s] = nxt[0]
            nxt[0] += 1
            return
        h = s // 2
        for dy in (0, h):
            for dx in (0, h):
                split(y0 + dy, x0 + dx, h)

    split(0, 0, F)
    return leaf


qt_cache = {}


def scheme_cost(day, scheme):
    nc = newc[day]
    dirty = {}
    for t, y, x in zip(nc["tile_id"], nc["fy"], nc["fx"]):
        dirty.setdefault(int(t), np.zeros((F, F), bool))[y, x] = True
    touched = set(dirty)
    cells_read = surf_read = 0
    units = 0
    if scheme == "tile":
        cells_read = sum(int(tiles[t].sum()) for t in touched)
        surf = {n for t in touched for n in neighbors(t) if n in tiles}
        surf_read = sum(int(tiles[t].sum()) for t in surf)
        units = len(surf)
        return cells_read, surf_read, units, len(touched)
    if scheme == "band":
        nb = {}
        for t, b in zip(nc["tile_id"], nc["band"]):
            nb.setdefault(int(t), set()).add(int(b))
        for t, bs in nb.items():
            if tiles[t].sum() < DENSE:
                cells_read += int(tiles[t].sum())
                continue
            m = np.zeros(1200, bool)
            for b in bs:
                m[max(b - 2, 0) : b + 3] = True  # one band each side dirty, one more read
            cells_read += int(band_n[t][m].sum())
        return cells_read, None, None, None
    # windows of size s fine cells, or quadtree leaves of at most n soundings
    for t in {n for u in touched for n in neighbors(u) if n in tiles}:
        g = tiles[t]
        # this tile's dirt, and its neighbours' new soundings near the shared edges
        canvas = np.zeros((3 * F, 3 * F), bool)
        counts = np.zeros((3 * F, 3 * F), np.int64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                at = np.s_[(1 + dy) * F : (2 + dy) * F, (1 + dx) * F : (2 + dx) * F]
                o = dirty.get(offset(t, dy, dx))
                if o is not None:
                    canvas[at] = o
                if (n := offset(t, dy, dx)) in tiles:
                    counts[at] = tiles[n]
        ry, rx = reach(t)
        d = dilate(canvas[F - ry : 2 * F + ry, F - rx : 2 * F + rx], ry, rx)[ry:-ry, rx:-rx]
        if not d.any():
            continue
        if g.sum() < DENSE:
            # A sparse tile rebuilds whole, its cells too once they read across edges.
            cells_read += int(g.sum())
            surf_read += int(g.sum())
            units += 1
            continue
        if scheme[0] == "win":
            s = scheme[1]
            w = d.reshape(F // s, s, F // s, s).any(axis=(1, 3))
            region = np.kron(w, np.ones((s, s), bool)).astype(bool)
            units += int(w.sum())
        else:
            key = (t, scheme[1])
            if key not in qt_cache:
                qt_cache[key] = quadtree(g, scheme[1])
            leaf = qt_cache[key]
            ids = np.unique(leaf[d])
            region = np.isin(leaf, ids)
            units += len(ids)
        # The halo reads neighbor tiles' soundings too.
        big = np.zeros((3 * F, 3 * F), bool)
        big[F : 2 * F, F : 2 * F] = region
        at = np.s_[F - ry : 2 * F + ry, F - rx : 2 * F + rx]
        read = int(counts[at][dilate(big[at], ry, rx)].sum())
        surf_read += read
        cells_read += read
    return cells_read, surf_read, units, len(touched)


schemes = [
    "tile",
    "band",
    ("win", 64),
    ("win", 16),
    ("win", 4),
    ("win", 2),
    ("qt", 1_000_000),
    ("qt", 250_000),
    ("qt", 100_000),
]
out = []
for d in days:
    row = {"day": str(d), "new": int(newc[d]["sum(n)"].sum()) if "sum(n)" in newc[d] else None}
    for s in schemes:
        c, su, u, tt = scheme_cost(d, s)
        row[str(s)] = {"cells": c, "surface": su, "units": u, "tiles": tt}
    out.append(row)
    print(json.dumps(row), flush=True)
Path(sys.argv[2]).write_text(json.dumps({"total": total, "days": out}))
