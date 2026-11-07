"""Prototype: compare full and windowed rebuilds of a tile.

    compare.py RUN DIR TILE DAY BOX_DIR...

DIR holds A (full, after DAY's arrivals) and B (full, before them), and each BOX_DIR a
windowed rebuild whose jobs.jsonl names its window. Reports, as JSON:

- influence: how far from the day's new soundings the full rebuilds' cells, cell-level flags
  and surface pixels differ (A against B);
- windows: inside each window, how the windowed rebuild differs from A.

DAY is the day `window.py --before` hid. Needs pandas, which the package doesn't depend on:
`uv run --with pandas python spikes/subtile/compare.py ...`.
"""

import json
import math
import sys
from pathlib import Path

import duckdb
import numpy as np
import rasterio
from scipy.spatial import cKDTree

from grid import tiles
from grid.catalog import POINT_ID

run, top, tile, day, boxes = (
    Path(sys.argv[1]),
    Path(sys.argv[2]),
    int(sys.argv[3]),
    sys.argv[4],
    sys.argv[5:],
)
lat0, lon0 = tile // 360 - 90, tile % 360 - 180
mx = 6378137 * math.pi / 180 * math.cos(math.radians(lat0 + 0.5))
my = 6378137 * math.pi / 180

with tiles.snapshot(run, "lake") as con:
    pts = con.execute(
        f"""SELECT {POINT_ID} AS point_id, p.lat, p.lon, f.arrival::DATE = DATE '{day}' AS new
        FROM lake.points p JOIN lake.files f USING (file_id)
        WHERE p.cell_id = {tiles.partition(tile)} AND p.tile_id = {tile}
          AND (f.status = 'active' OR f.arrival::DATE < DATE '{day}')"""
    ).df()
new = pts[pts.new]
tree = cKDTree(np.column_stack([(new.lon - lon0) * mx, (new.lat - lat0) * my]))


def far(lon, lat):
    """Metres to the nearest new sounding."""
    if not len(lon):
        return np.empty(0)
    return tree.query(
        np.column_stack([(np.asarray(lon) - lon0) * mx, (np.asarray(lat) - lat0) * my])
    )[0]


def summary(d):
    d = np.asarray(d)
    if not len(d):
        return {"n": 0}
    return {
        "n": len(d),
        "p50_m": round(float(np.median(d))),
        "p99_m": round(float(np.quantile(d, 0.99))),
        "max_m": round(float(d.max())),
    }


db = duckdb.connect()
db.register("pts", pts)


def cells_of(d):
    return db.execute(
        f"SELECT * EXCLUDE (cell_id) FROM read_parquet('{d}/cells/{tile}.parquet')"
    ).df()


def diff_rows(a, b):
    """Rows of a not in b and of b not in a, as one frame with each row's position."""
    db.register("a", a)
    db.register("b", b)
    return db.execute(
        """SELECT (lon_min + lon_max) / 2 AS lon, (lat_min + lat_max) / 2 AS lat FROM
        (SELECT * FROM a EXCEPT SELECT * FROM b UNION ALL (SELECT * FROM b EXCEPT SELECT * FROM a))"""
    ).df()


def flags_diff(da, db_):
    return db.execute(
        f"""WITH a AS (SELECT * FROM read_parquet('{da}/flags/{tile}.parquet')),
        b AS (SELECT * FROM read_parquet('{db_}/flags/{tile}.parquet')),
        d AS (SELECT point_id FROM (SELECT * FROM a EXCEPT SELECT * FROM b
              UNION ALL (SELECT * FROM b EXCEPT SELECT * FROM a)))
        SELECT DISTINCT p.point_id, p.lon, p.lat FROM d JOIN pts p USING (point_id)"""
    ).df()


def surface(d):
    with rasterio.open(d / "surface" / f"{tile}.tif") as src:
        return src.read(), src.transform


out = {"tile": tile, "new_soundings": len(new)}
A, B = top / "A", top / "B"
cd = diff_rows(cells_of(A), cells_of(B))
fd = flags_diff(A, B)
sa, transform = surface(A)
sb, _ = surface(B)
rows, cols = np.nonzero((sa != sb).any(axis=0))
xs, ys = rasterio.transform.xy(transform, rows, cols)
out["influence"] = {
    "cells": summary(far(cd.lon, cd.lat)),
    "flags": summary(far(fd.lon, fd.lat)),
    "surface_pixels": summary(far(xs, ys)),
}

out["windows"] = []
for bd in map(Path, boxes):
    jobs = [json.loads(line) for line in (bd / "jobs.jsonl").read_text().splitlines()]
    s, n, w, e = jobs[0]["window"]
    inside_cells = (
        f"(lat_min + lat_max) / 2 >= {s} AND (lat_min + lat_max) / 2 < {n}"
        f" AND (lon_min + lon_max) / 2 >= {w} AND (lon_min + lon_max) / 2 < {e}"
    )
    a = db.execute(
        f"SELECT * FROM (SELECT * EXCLUDE (cell_id) FROM read_parquet('{A}/cells/{tile}.parquet')) WHERE {inside_cells}"
    ).df()
    c = db.execute(
        f"SELECT * FROM (SELECT * EXCLUDE (cell_id) FROM read_parquet('{bd}/cells/{tile}.parquet')) WHERE {inside_cells}"
    ).df()
    cdiff = diff_rows(a, c)
    # Which columns differ, for cells at the same key.
    db.register("a", a)
    db.register("c", c)
    cols_differ = {}
    for col in a.columns:
        if col in ("level", "row", "col"):
            continue
        k = db.execute(
            f'SELECT count(*) FROM a JOIN c USING (level, "row", col) WHERE a."{col}" IS DISTINCT FROM c."{col}"'
        ).fetchone()[0]
        if k:
            cols_differ[col] = int(k)
    fdiff = flags_diff(A, bd)
    fdiff = fdiff[(fdiff.lat >= s) & (fdiff.lat < n) & (fdiff.lon >= w) & (fdiff.lon < e)]
    win = {
        "window": [s, n, w, e],
        "jobs": jobs,
        "cells_a": len(a),
        "cells_differ": len(cdiff),
        "columns_differ": cols_differ,
        "flags_differ": len(fdiff),
    }
    if (bd / "surface" / f"{tile}.tif").exists():
        sc, _ = surface(bd)
        r0, c0 = rasterio.transform.rowcol(transform, w, n)
        r1, c1 = rasterio.transform.rowcol(transform, e, s)
        r0, c0 = max(r0, 0), max(c0, 0)
        ia, ic = sa[:, r0:r1, c0:c1], sc[:, r0:r1, c0:c1]
        nodata = -9999.0
        win["surface"] = {
            "pixels": int((ia[0] != nodata).sum()),
            "differ": {f"band{b + 1}": int((ia[b] != ic[b]).sum()) for b in range(ia.shape[0])},
            "max_abs_depth_m": float(
                np.abs(np.where((ia[0] != nodata) & (ic[0] != nodata), ia[0] - ic[0], 0)).max()
            ),
            "max_abs_sigma_m": float(
                np.abs(np.where((ia[3] != nodata) & (ic[3] != nodata), ia[3] - ic[3], 0)).max()
            ),
            "data_mismatch": int(((ia[0] == nodata) != (ic[0] == nodata)).sum()),
        }
    out["windows"].append(win)
print(json.dumps(out, indent=1, default=str))
