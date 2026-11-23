"""Measure the seams between 1° tiles in a `grid tiles` run: where coverage stops at a tile
edge on one side, and where the depth bands either side of an edge disagree.

    seams.py RUN [OUT.json]

Each shared edge of two tiles with depth areas is sampled at every surface pixel along it.
At each sample a point is taken half a pixel, a pixel and a half and two and a half pixels
into each tile, and looked up in that tile's own DEPARE polygons (`RUN/areas/{tile}.geojsons`).
A sample is active when either side has a depth area within those three pixels; coverage
stops on one side when one side has an area there and the other has none. Where both sides
have an area at half a pixel, their bands (DRVAL1) agree or not.
"""

import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import shapely

from grid.cells import k_for
from grid.surface import ROWS

run = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else None
INSETS = (0.5, 1.5, 2.5)  # pixels into each tile


def areas(tile):
    """A tile's DEPARE polygons and their DRVAL1, with an STRtree over them, or None."""
    path = run / "areas" / f"{tile}.geojsons"
    if not path.exists():
        return None
    geoms, bands = [], []
    for line in path.open():
        line = line.strip().lstrip("\x1e")
        if not line:
            continue
        f = json.loads(line)
        if f.get("tippecanoe", {}).get("layer") != "DEPARE":
            continue
        geoms.append(shapely.geometry.shape(f["geometry"]))
        bands.append(f["properties"]["DRVAL1"])
    if not geoms:
        return None
    return shapely.STRtree(geoms), np.array(bands, dtype=float)


def band_at(tree_bands, x, y):
    """The DRVAL1 of the area holding each point, or NaN where none does."""
    tree, bands = tree_bands
    got = np.full(len(x), np.nan)
    pts, hit = tree.query(shapely.points(x, y), predicate="intersects")
    # Bands never overlap within a tile; where a point is on a shared edge, take the shoaler.
    np.fmin.at(got, pts, bands[hit])
    return got


def edges(tiles):
    """Each pair of tiles sharing an edge, as (a, b, axis): b east of a, or b north of a."""
    have = set(tiles)
    for t in sorted(have):
        lat0, lon0 = t // 360 - 90, t % 360 - 180
        east = (lat0 + 90) * 360 + (lon0 + 1 + 180) % 360
        if east in have:
            yield t, east, "lon"
        if t + 360 in have:
            yield t, t + 360, "lat"


tiles = [int(p.stem) for p in (run / "areas").glob("*.geojsons") if p.stem.isdigit()]
loaded = {t: a for t in tiles if (a := areas(t)) is not None}
totals = Counter()
per_edge = []
for a, b, axis in edges(loaded):
    lat0, lon0 = a // 360 - 90, a % 360 - 180
    # Pixel sizes in degrees: rows of 1/ROWS°, columns k times wider than the cells' base.
    dy = 1 / ROWS
    dx = k_for(lat0) / ROWS
    if axis == "lon":
        along = lat0 + (np.arange(ROWS) + 0.5) * dy
        edge = lon0 + 1
        sides = (
            [(np.full(ROWS, edge - i * dx), along) for i in INSETS],
            # The east tile's own longitudes: at 180° its polygons start at -180°.
            [(np.full(ROWS, (edge + i * dx + 180) % 360 - 180), along) for i in INSETS],
        )
    else:
        cols = math.ceil(1 / dx)
        along = lon0 + (np.arange(cols) + 0.5) * dx
        edge = lat0 + 1
        sides = (
            [(along, np.full(cols, edge - i * dy)) for i in INSETS],
            [(along, np.full(cols, edge + i * dy)) for i in INSETS],
        )
    got = []
    for tile, points in ((a, sides[0]), (b, sides[1])):
        got.append(np.stack([band_at(loaded[tile], x, y) for x, y in points]))
    near_a, near_b = ~np.isnan(got[0]).all(axis=0), ~np.isnan(got[1]).all(axis=0)
    active = near_a | near_b
    one_side = near_a ^ near_b
    both = ~np.isnan(got[0][0]) & ~np.isnan(got[1][0])
    mismatch = both & (got[0][0] != got[1][0])
    counts = {
        "active": int(active.sum()),
        "one_side": int(one_side.sum()),
        "both": int(both.sum()),
        "mismatch": int(mismatch.sum()),
    }
    totals.update(counts)
    per_edge.append({"a": a, "b": b, "axis": axis, **counts})

result = {
    "run": str(run),
    "tiles_with_areas": len(loaded),
    "shared_edges": len(per_edge),
    "edges_with_areas": sum(e["active"] > 0 for e in per_edge),
    **totals,
    "one_side_share": totals["one_side"] / totals["active"] if totals["active"] else None,
    "mismatch_share": totals["mismatch"] / totals["both"] if totals["both"] else None,
    "edges": per_edge,
}
if out:
    out.write_text(json.dumps(result, indent=1) + "\n")
print(
    f"{result['shared_edges']} shared edges, {result['edges_with_areas']} with areas near them; "
    f"coverage stops on one side in {totals['one_side']:,} of {totals['active']:,} active samples "
    f"({result['one_side_share'] or 0:.1%}); bands differ in {totals['mismatch']:,} of "
    f"{totals['both']:,} samples with areas on both sides ({result['mismatch_share'] or 0:.1%})"
)
worst = sorted(
    per_edge, key=lambda e: -e["mismatch"] / max(e["both"], 1) if e["both"] > 200 else 0
)[:5]
for e in worst:
    print(f"  {e['a']}/{e['b']}: bands differ in {e['mismatch']} of {e['both']}")
