"""Compare two `grid tiles` runs tile by tile: cells, shoals and cell-level flags row for row,
and the surface's five bands pixel for pixel.

    runs_compare.py RUN_A RUN_B [TILE...]
"""

import json
import sys
from pathlib import Path

import duckdb
import rasterio

from grid import tiles

a, b = Path(sys.argv[1]), Path(sys.argv[2])
wanted = [int(t) for t in sys.argv[3:]] or sorted(tiles.counts(a))
con = duckdb.connect()
con.execute("SET threads = 8")
report = {"tiles": len(wanted), "differ": {}}
for t in wanted:
    diffs = {}
    for kind in ("cells", "shoals", "flags"):
        pa, pb = (r / tiles.TILE_FILES[kind].format(t) for r in (a, b))
        if pa.exists() != pb.exists():
            diffs[kind] = "missing in one"
            continue
        if not pa.exists():
            continue
        [(n_a, n_b, only)] = con.execute(
            """SELECT (SELECT count(*) FROM read_parquet($a)), (SELECT count(*) FROM read_parquet($b)),
              (SELECT count(*) FROM ((FROM read_parquet($a) EXCEPT ALL FROM read_parquet($b))
                UNION ALL (FROM read_parquet($b) EXCEPT ALL FROM read_parquet($a))))""",
            {"a": str(pa), "b": str(pb)},
        ).fetchall()
        if only:
            diffs[kind] = {"rows": [n_a, n_b], "differing": only}
    sa, sb = (r / tiles.TILE_FILES["surface"].format(t) for r in (a, b))
    if sa.exists() != sb.exists():
        diffs["surface"] = "missing in one"
    elif sa.exists():
        with rasterio.open(sa) as x, rasterio.open(sb) as y:
            bands = {}
            for i in range(1, 6):
                n = int((x.read(i) != y.read(i)).sum())
                if n:
                    bands[i] = n
            if bands:
                diffs["surface"] = bands
    if diffs:
        report["differ"][t] = diffs
    print(t, diffs or "same", flush=True)
print(json.dumps(report))
