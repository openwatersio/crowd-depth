"""Prototype: the 1/W° windows of a tile that a day's arrivals dirty, with each window's
active soundings and the day's new ones, as JSON lines.

    dirty.py RUN TILE DAY [--per-degree 8] [--reach DEG]

A window is dirty when one of the tile's own new soundings lies within REACH degrees of it (in
longitude, REACH / cos(lat)); neighbor tiles' aren't counted. The doc's figures used the
default, about 610 m.
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np

from grid import tiles

p = argparse.ArgumentParser()
p.add_argument("run", type=Path)
p.add_argument("tile", type=int)
p.add_argument("day")
p.add_argument("--per-degree", type=int, default=8)
p.add_argument("--reach", type=float, default=0.0055)
a = p.parse_args()

lat0, lon0 = a.tile // 360 - 90, a.tile % 360 - 180
w = a.per_degree
ry, rx = a.reach, a.reach / math.cos(math.radians(lat0 + 0.5))
with tiles.snapshot(a.run, "lake") as con:
    con.execute(
        f"""CREATE TEMP TABLE pts AS
        SELECT p.lat, p.lon, f.arrival::DATE = DATE '{a.day}' AS new FROM lake.points p
        JOIN lake.files f USING (file_id)
        WHERE p.cell_id = {tiles.partition(a.tile)} AND p.tile_id = {a.tile}
          AND f.status = 'active'"""
    )
    counts = con.execute(
        f"""SELECT least(floor((lat - {lat0}) * {w}), {w - 1})::INT AS wy,
          least(floor((lon - {lon0}) * {w}), {w - 1})::INT AS wx,
          count(*), count(*) FILTER (WHERE new) FROM pts GROUP BY ALL"""
    ).fetchall()
    new = con.execute(
        "SELECT DISTINCT lat, lon FROM pts WHERE new"
    ).fetchnumpy()
lat, lon = (np.asarray(v, dtype=float) for v in new.values())
dirty = set()
# Every window from the reach's south-west corner to its north-east one, however narrow.
y0 = np.floor((lat - ry - lat0) * w).astype(int)
y1 = np.floor((lat + ry - lat0) * w).astype(int)
x0 = np.floor((lon - rx - lon0) * w).astype(int)
x1 = np.floor((lon + rx - lon0) * w).astype(int)
for oy in range(int((y1 - y0).max(initial=0)) + 1):
    for ox in range(int((x1 - x0).max(initial=0)) + 1):
        keep = (y0 + oy <= y1) & (x0 + ox <= x1)
        wy = np.clip(y0[keep] + oy, 0, w - 1)
        wx = np.clip(x0[keep] + ox, 0, w - 1)
        dirty |= set(zip(wy.tolist(), wx.tolist()))
by = {(wy, wx): (n, nn) for wy, wx, n, nn in counts}
for wy, wx in sorted(by.keys() | dirty):
    n, nn = by.get((wy, wx), (0, 0))
    box = [lat0 + wy / w, lat0 + (wy + 1) / w, lon0 + wx / w, lon0 + (wx + 1) / w]
    print(
        json.dumps(
            {
                "tile": a.tile,
                "wy": wy,
                "wx": wx,
                "n": n,
                "new": nn,
                "dirty": (wy, wx) in dirty,
                "box": box,
            }
        )
    )
