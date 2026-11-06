"""Prototype: a tile's cells or surface rebuilt from a window of its points, on a run's frozen
catalog, without changing cells.py or surface.py.

    window.py RUN OUT cells|surface TILE [--before DAY] [--window S N W E --halo DEG]
        [--flags DIR ...]

--before shows the catalog as it stood before DAY's arrivals: files that arrived on DAY or
later read as withdrawn. It doesn't undo what ingest did when they arrived, so it is exact only
when they superseded no older file (true of the Chesapeake's last arrival day), and DAY should
be the last arrival day, since later ones are hidden too. --window keeps only the points within HALO degrees
of the box (in longitude, HALO / cos(lat)). --flags names run directories to read neighbors'
cell-level flags from for a surface, OUT first, first match wins: name a full run's, since a
windowed cells run's flags cover only its window and halo. Writes
OUT/{cells,shoals,flags,surface} and appends a line to OUT/jobs.jsonl.
"""

import argparse
import json
import math
import resource
import sys
import time
from pathlib import Path

from grid import cells, surface, tiles
from grid.catalog import ACTIVE_POINTS
from grid.cells import CELL_REASONS

p = argparse.ArgumentParser()
p.add_argument("run", type=Path)
p.add_argument("out", type=Path)
p.add_argument("stage", choices=["cells", "surface"])
p.add_argument("tile", type=int)
p.add_argument("--before")
p.add_argument("--window", type=float, nargs=4)
p.add_argument("--halo", type=float, default=0.0)
p.add_argument("--flags", type=Path, nargs="*", default=[])
p.add_argument("--threads", type=int, default=4)
p.add_argument(
    "--nearest-px",
    type=float,
    help="take σ's fallback spread only from a pixel this near, else none (statistic.nearest)",
)

p.add_argument(
    "--ties",
    action="store_true",
    help="among pixels equally near, take the largest value, not the tree's pick; needs --nearest-px",
)
a = p.parse_args()
if a.ties and not a.nearest_px:
    p.error("--ties needs --nearest-px, which bounds how many pixels can tie")

if a.nearest_px or a.ties:
    import numpy as np
    from scipy.spatial import cKDTree

    from grid import statistic

    # Within 25 pixels a grid point has at most 24 others at one distance (at 325 px²).
    TIES = 32

    def nearest(x, y, values, bound=a.nearest_px or np.inf, k=TIES if a.ties else 1):
        have = ~np.isnan(values)
        if not have.any():
            return lambda qx, qy: np.full(len(qx), np.nan)
        tree = cKDTree(np.stack([x[have], y[have]], axis=1))
        taken = np.append(values[have], np.nan)

        def at(qx, qy):
            d, i = tree.query(np.stack([qx, qy], axis=1), k=k, distance_upper_bound=bound)
            if k == 1:
                return taken[i]
            # Pixels sit on an integer grid, so equal distances are exactly equal.
            assert not (np.isfinite(d[:, -1]) & (d[:, -1] == d[:, 0])).any(), "more ties than k"
            v = np.where(d == d[:, :1], taken[i], -np.inf)
            best = v.max(axis=1)
            return np.where(np.isfinite(best), best, np.nan)

        return at

    statistic.nearest = nearest

t0 = time.time()
around = tiles.neighbors(a.tile) if a.stage == "surface" else [a.tile]
limit = tiles.CELLS_MEMORY_LIMIT if a.stage == "cells" else tiles.JOB_MEMORY_LIMIT
got = None
with tiles.snapshot(a.run, threads=a.threads, memory_limit=limit) as con:
    tables = [
        t
        for (t,) in con.execute(
            "SELECT table_name FROM duckdb_tables() WHERE database_name = 'lake'"
        ).fetchall()
    ]
    parts = ",".join(map(str, sorted({tiles.partition(t) for t in around})))
    ids = ",".join(map(str, around))
    where = f"cell_id IN ({parts}) AND tile_id IN ({ids})"
    box = ""
    if a.window:
        s, n, w, e = a.window
        hx = a.halo / math.cos(math.radians((s + n) / 2))
        box = (
            f" AND lat >= {s - a.halo} AND lat < {n + a.halo}"
            f" AND lon >= {w - hx} AND lon < {e + hx}"
        )
    for t in tables:
        if t in tiles.WRITTEN:
            continue
        con.execute(f"DROP TABLE lake.{t}")
        if t == "points":
            con.execute(f"CREATE VIEW lake.points AS SELECT * FROM store.points WHERE {where}{box}")
        elif t == "files" and a.before:
            con.execute(
                f"""CREATE VIEW lake.files AS SELECT * REPLACE (CASE
                WHEN arrival >= DATE '{a.before}' THEN 'withdrawn' ELSE status END AS status)
                FROM store.files"""
            )
        else:
            con.execute(f"CREATE VIEW lake.{t} AS SELECT * FROM store.{t}")
    con.execute("INSERT INTO lake.store_meta SELECT * FROM store.store_meta")
    con.execute(
        f"""INSERT INTO lake.qc_flags SELECT * FROM store.qc_flags
        WHERE {where} AND NOT list_contains({CELL_REASONS}, reason)"""
    )
    con.execute(ACTIVE_POINTS)
    n_points = con.execute("SELECT count(*) FROM lake.points").fetchone()[0]
    if a.stage == "cells":
        if n_points:
            cells.build(con, [a.tile])
        for kind, order in (("cells", 'level, "row", col'), ("shoals", '"row", lon, lat')):
            tiles.export(
                con,
                f"SELECT * FROM lake.{kind} WHERE tile_id = {a.tile} ORDER BY {order}",
                a.out / tiles.TILE_FILES[kind].format(a.tile),
            )
        tiles.export(
            con,
            f"""SELECT * FROM lake.qc_flags WHERE tile_id = {a.tile}
            AND list_contains({CELL_REASONS}, reason) ORDER BY point_id, flag, reason""",
            a.out / tiles.TILE_FILES["flags"].format(a.tile),
        )
    else:
        for t in around:
            for d in [a.out, *a.flags]:
                f = d / tiles.TILE_FILES["flags"].format(t)
                if f.exists():
                    con.execute(
                        "INSERT INTO lake.qc_flags BY NAME SELECT * FROM read_parquet(?)", [str(f)]
                    )
                    break
        got = surface.tile_entries(con, a.tile, tiles.partition(a.tile))
if got:
    path = a.out / tiles.TILE_FILES["surface"].format(a.tile)
    path.parent.mkdir(parents=True, exist_ok=True)
    surface.grid_tile(a.tile, got, path.parent)
a.out.mkdir(parents=True, exist_ok=True)
with open(a.out / "jobs.jsonl", "a") as f:
    f.write(
        json.dumps(
            {
                "stage": a.stage,
                "tile": a.tile,
                "window": a.window,
                "halo": a.halo,
                "before": a.before,
                "points": n_points,
                "seconds": round(time.time() - t0, 1),
                # Bytes on macOS, KiB on Linux.
                "maxrss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                // (2**20 if sys.platform == "darwin" else 2**10),
            }
        )
        + "\n"
    )
