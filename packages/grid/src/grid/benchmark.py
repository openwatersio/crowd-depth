"""Benchmark: the published depth against surveyed references, so a render or statistic
change comes with numbers comparable to the last.

Truth is the store's `lake.reference_pixels` (S-102, BlueTopo, at chart datum), one per
2/3″ surface pixel: where several sources sampled a pixel, the least uncertain. Each
surface COG is read on its own pixel grid, the grid the references were sampled on, so
no pixel is resampled; a COG on any other grid is refused. Optionally the cells are
scored too: at each pixel, the shoalest depth of the cells, of any level, whose depth
position is in it.

What the numbers can't say:
- Calibration anchors vessel offsets on these same references, so scores over anchor
  pixels flatter the result. The `anchor` class marks pixels where any source's sample
  meets calibration's anchor limits (depth, uncertainty, relief); `held out` is the fairer
  number, though it is mostly water calibration doesn't anchor in: under 2 m, over 20 m,
  or on a slope. A pixel within the limits is marked whether or not a vessel's segment
  anchored on it, so `anchor` errs large and `held out` small.
- References are sampled only where calibration had soundings, so an `interpolated` pixel
  is mostly one whose soundings the surface didn't take, or whose file has since gone,
  rarely water between tracks.
- The surface is what the render wrote; vessels, shoals and cells are the store as it is
  now. Benchmark a render against the store it was rendered from.
- The reference's shoalest is its depth (a mean within about 10 m) less its relief
  (highest less lowest within about 20 m): shoaler than the surveyed minimum on a slope,
  so the too-deep share there errs high.
"""

import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from scipy.ndimage import maximum_filter

from .calibrate import ANCHOR_DEPTH_M, ANCHOR_RELIEF_M, ANCHOR_UNCERTAINTY_M
from .catalog import MIN_DEPTH_M
from .cells import BASE, k_for
from .qc import MAX_DEPTH_M, QC_VERSION
from .surface import NODATA, PIXEL_BASE, ROWS, partition_of

# One reference per pixel, the least uncertain of the wanted sources, and whether any
# source's sample there meets calibration's anchor limits. Calibration numbers a sounding on
# a tile's north or east edge past its last pixel; the surface puts it in that pixel.
TRUTH = f"""
SELECT py, px, depth, relief, source, anchor FROM (
  SELECT least(py, {ROWS - 1}) AS py, least(px, $cols - 1) AS px, depth,
    coalesce(relief, 0) AS relief, uncertainty, source,
    coalesce(bool_or(depth BETWEEN {ANCHOR_DEPTH_M[0]} AND {ANCHOR_DEPTH_M[1]}
      AND uncertainty < {ANCHOR_UNCERTAINTY_M} AND relief < {ANCHOR_RELIEF_M})
      OVER (PARTITION BY least(py, {ROWS - 1}), least(px, $cols - 1)), false) AS anchor
  FROM lake.reference_pixels WHERE tile_id = $tile AND depth IS NOT NULL
)
WHERE len($sources) = 0 OR list_contains($sources, source)
QUALIFY row_number() OVER (PARTITION BY py, px ORDER BY uncertainty NULLS LAST, source, depth) = 1
"""

# Per sounded pixel: the vessels with a sounding the surface would take (QC accepted: not
# rejected or noisy, not in a run whose sounder lost the bottom, and not an unconfirmed shoal unless
# something confirmed it or it's one no cell could judge; within the depths it trusts), and
# whether a confirmed shoal is there, as the statistic's cells flag one.
SOUNDED = f"""
WITH pts AS MATERIALIZED (
  SELECT p.point_id, p.unique_id,
    least(greatest(floor((p.lat - $lat0) * {BASE} / 2)::INTEGER, 0), {ROWS - 1}) AS py,
    least(greatest(floor((p.lon - $lon0) * {BASE} / $k / 2)::INTEGER, 0), $cols - 1) AS px
  FROM corrected_points_in($partition, [$tile], 0, {BASE}) p
  WHERE p.depth_raw > 0 AND p.depth_raw <= {MAX_DEPTH_M} AND p.depth >= {MIN_DEPTH_M}
    AND NOT p.excluded AND NOT p.lost_bottom AND NOT p.awaiting_tide
),
flags AS (
  SELECT point_id, bool_or(flag IN ('reject', 'noisy')) AS rejected,
    bool_or(flag = 'unconfirmed' AND reason <> 'cell_unjudged') AND NOT bool_or(flag = 'confirmed')
      AS unconfirmed,
    bool_or(flag = 'confirmed' AND reason = 'cell_shoal') AS shoal
  FROM lake.qc_flags WHERE cell_id = $partition AND qc_version = $qc_version
    AND point_id IN (SELECT point_id FROM pts)
  GROUP BY point_id
)
SELECT py, px,
  count(DISTINCT unique_id) FILTER (
    WHERE NOT coalesce(rejected, false) AND NOT coalesce(unconfirmed, false)) AS vessels,
  coalesce(bool_or(shoal), false) AS shoal
FROM pts LEFT JOIN flags USING (point_id) GROUP BY py, px
"""

DEPTHS = [(-math.inf, 2, "<2 m"), (2, 5, "2–5 m"), (5, 12, "5–12 m"), (12, math.inf, "≥12 m")]
VESSELS = [(0, 0, "0"), (1, 1, "1"), (2, 3, "2–3"), (4, 9, "4–9"), (10, math.inf, "10+")]
COLUMNS = [
    ("pixels", "Pixels", "{:,}"),
    ("coverage", "Covered", "{:.1%}"),
    ("bias_m", "Bias m", "{:+.2f}"),
    ("too_deep", ">1 m too deep", "{:.2%}"),
    ("false_shoal", ">2 m false shoal", "{:.2%}"),
    ("under_1m_over_2m", "<1 m over ≥2 m", "{:.2%}"),
    ("roughness_m", "Roughness m", "{:.3f}"),
    ("sigma_m", "σ m", "{:.2f}"),
]


def floats(res, name):
    """A fetchnumpy column as float64 with NULL as NaN: np.asarray would make it 0."""
    return np.ma.filled(np.ma.asarray(res[name]).astype(np.float64), np.nan)


def tile_pixels(con, tile, surface_dir, sources, qc_version, with_cells):
    """Every reference pixel of a tile, with the estimates and classes at it, or None."""
    lat0, lon0 = tile // 360 - 90, tile % 360 - 180
    k = k_for(lat0)
    cols = math.ceil(BASE / k / PIXEL_BASE)
    truth = con.execute(TRUTH, {"tile": tile, "sources": sources, "cols": cols}).fetchnumpy()
    if not len(truth["py"]):
        return None
    py, px = truth["py"].astype(np.int64), truth["px"].astype(np.int64)
    at = (ROWS - 1 - py, px)
    out = {
        "ref": floats(truth, "depth"),
        "relief": floats(truth, "relief"),
        "shoalest": floats(truth, "depth") - floats(truth, "relief"),
        "source": np.asarray(truth["source"], dtype=object),
        "anchor": np.asarray(truth["anchor"], dtype=bool),
    }
    path = Path(surface_dir) / f"{tile}.tif"
    depth = np.full((ROWS, cols), np.nan, dtype=np.float32)
    count = np.zeros((ROWS, cols), dtype=np.float32)
    sigma = np.full((ROWS, cols), np.nan, dtype=np.float32)
    if path.exists():
        with rasterio.open(path) as src:
            if not on_grid(src, lon0, lat0, cols):
                raise ValueError(f"{path} is not on tile {tile}'s surface pixel grid")
            depth = src.read(1)
            depth[depth == NODATA] = np.nan
            count = src.read(3)
            if src.count >= 4:
                sigma = src.read(4)
                sigma[sigma == NODATA] = np.nan
    out["surface"] = depth[at]
    out["surface_rough"] = neighbour_differences(depth, at)
    out["sigma"] = sigma[at]
    out["measured"] = count[at] > 0
    sounded = con.execute(
        SOUNDED,
        {"partition": partition_of(lat0, lon0), "tile": tile, "lat0": lat0, "lon0": lon0,
         "k": k, "cols": cols, "qc_version": qc_version},
    ).fetchnumpy()  # fmt: skip
    vessels = np.zeros((ROWS, cols), dtype=np.int32)
    shoal = np.zeros((ROWS, cols), dtype=bool)
    where = (ROWS - 1 - sounded["py"].astype(np.int64), sounded["px"].astype(np.int64))
    vessels[where] = sounded["vessels"]
    shoal[where] = sounded["shoal"]
    out["vessels"] = vessels[at]
    out["near_shoal"] = maximum_filter(shoal, size=3, mode="constant")[at]
    if with_cells:
        c = con.execute(
            """SELECT depth, depth_lon, depth_lat FROM lake.cells
            WHERE cell_id = $partition AND tile_id = $tile AND depth IS NOT NULL
              AND depth_lon IS NOT NULL""",
            {"partition": partition_of(lat0, lon0), "tile": tile},
        ).fetchnumpy()
        grid = np.full((ROWS, cols), np.nan, dtype=np.float32)
        r = ROWS - 1 - np.clip(np.floor((floats(c, "depth_lat") - lat0) * BASE / 2), 0, ROWS - 1)
        q = np.clip(np.floor((floats(c, "depth_lon") - lon0) * BASE / k / 2), 0, cols - 1)
        # The shoalest cell whose depth is in a pixel: every level's cell is somewhere.
        np.fmin.at(grid, (r.astype(np.int64), q.astype(np.int64)), floats(c, "depth"))
        out["cells"] = grid[at]
        out["cells_rough"] = neighbour_differences(grid, at)
        out["cells_sigma"] = np.full(len(at[0]), np.nan, dtype=np.float32)
    out["surface_sigma"] = out.pop("sigma")
    return out


def on_grid(src, lon0, lat0, cols):
    """Whether a raster is the tile's surface grid, to a hundredth of a pixel at every corner."""
    want = from_bounds(lon0, lat0, lon0 + 1, lat0 + 1, cols, ROWS)
    corners = [(0, 0), (cols, 0), (0, ROWS), (cols, ROWS)]
    return (
        src.crs == "EPSG:4326"
        and (src.height, src.width) == (ROWS, cols)
        and all(
            abs(a - b) < 0.01 * step
            for c in corners
            for a, b, step in zip(src.transform @ c, want @ c, (want.a, -want.e))
        )
    )


def neighbour_differences(grid, at):
    """|difference| to each of a pixel's 4 neighbours, NaN where either has no depth."""
    padded = np.pad(grid, 1, constant_values=np.nan)
    r, c = at[0] + 1, at[1] + 1
    here = padded[r, c]
    return np.abs(
        np.stack([padded[r - 1, c], padded[r + 1, c], padded[r, c - 1], padded[r, c + 1]], 1)
        - here[:, None]
    ).astype(np.float32)


def score(est, ref, shoalest, rough, sigma):
    """The metrics over some pixels; shares are of the pixels the estimate covers."""
    have = ~np.isnan(est)
    e, r, s = est[have], ref[have], shoalest[have]
    deep = r >= 2
    rough = rough[have].ravel()
    rough = rough[~np.isnan(rough)]
    sigma = sigma[have]
    sigma = sigma[~np.isnan(sigma)]
    # Shares are of covered pixels; the under-1 m share is of those with a reference of 2 m or more.
    return {
        "pixels": len(est),
        "covered": int(have.sum()),
        "coverage": float(have.mean()) if len(est) else None,
        "bias_m": float(np.median(e - r)) if len(e) else None,
        "too_deep": float(np.mean(e > s + 1)) if len(e) else None,
        "false_shoal": float(np.mean(e < r - 2)) if len(e) else None,
        "under_1m_over_2m": float(np.mean(e[deep] < 1)) if deep.any() else None,
        "roughness_m": float(np.median(rough)) if len(rough) else None,
        "sigma_m": float(np.median(sigma)) if len(sigma) else None,
    }


def classes(p):
    """Each class's pixels, as {group: {label: mask}}."""
    ref, vessels = p["ref"], p["vessels"]
    return {
        "depth": {label: (ref >= lo) & (ref < hi) for lo, hi, label in DEPTHS},
        "slope": {"slope": p["relief"] > 0.5, "flat": p["relief"] <= 0.5},
        "measured": {"measured": p["measured"], "interpolated": ~p["measured"]},
        "vessels": {label: (vessels >= lo) & (vessels <= hi) for lo, hi, label in VESSELS},
        "confirmed_shoal": {"within 1 pixel": p["near_shoal"], "not": ~p["near_shoal"]},
        "anchor": {"anchor": p["anchor"], "held out": ~p["anchor"]},
        "source": {s: p["source"] == s for s in sorted(set(p["source"]))},
    }


def run(con, surface_dir, tiles=None, sources=(), qc_version=QC_VERSION, with_cells=False):
    """Score the surface in `surface_dir` (and the cells) on `tiles`, or on every tile
    the directory has a COG for."""
    surface_dir = Path(surface_dir)
    if tiles is None:
        tiles = [int(p.stem) for p in surface_dir.glob("*.tif") if p.stem.isdigit()]
    tiles = sorted(set(tiles))
    missing = [t for t in tiles if not (surface_dir / f"{t}.tif").exists()]
    if len(missing) == len(tiles):
        raise ValueError(f"{surface_dir} has no surface COG for these tiles")
    # ponytail: every reference pixel's values are held at once, about 50 bytes each;
    # keep per-class histograms instead if a run's region outgrows memory.
    found = {
        t: p for t in tiles
        if (p := tile_pixels(con, t, surface_dir, list(sources), qc_version, with_cells))
    }  # fmt: skip
    parts = list(found.values())
    missing = [t for t in missing if t in found]
    if not parts:
        raise ValueError("no reference pixels in these tiles")
    p = {k: np.concatenate([q[k] for q in parts]) for k in parts[0]}
    # The flags on the scored tiles' own soundings: another tile's in the same partition
    # say nothing about these. The partitions only let both tables prune their files.
    scored = sorted(found)
    partitions = sorted({partition_of(t // 360 - 90, t % 360 - 180) for t in scored})
    flagged = con.execute(
        """SELECT count(*) FROM lake.qc_flags q JOIN lake.points p USING (point_id)
        WHERE q.qc_version = $v AND list_contains($parts, q.cell_id)
          AND list_contains($parts, p.cell_id) AND list_contains($tiles, p.tile_id)""",
        {"v": qc_version, "parts": partitions, "tiles": scored},
    ).fetchone()[0]
    sources_seen, counts = np.unique(p["source"], return_counts=True)
    result = {
        "surface": str(surface_dir),
        "tiles": tiles,
        # A tile with references but no COG counts against coverage.
        "tiles_without_surface": missing,
        "qc_version": qc_version,
        "qc_flags_at_version": flagged,
        "sources": sorted(set(p["source"])),
        "reference_pixels": {str(k): int(n) for k, n in zip(sources_seen, counts)},
        "caveat": "Calibration anchors vessel offsets on these references: the 'anchor'"
        " class's pixels flatter the result, and 'held out' is the fairer number.",
        "estimates": {},
    }
    groups = classes(p)
    for name in ("surface", "cells") if with_cells else ("surface",):

        def of(mask, name=name):
            return score(p[name][mask], p["ref"][mask], p["shoalest"][mask],
                         p[f"{name}_rough"][mask], p[f"{name}_sigma"][mask])  # fmt: skip

        result["estimates"][name] = {
            "overall": of(np.ones(len(p["ref"]), dtype=bool)),
            "classes": {g: {label: of(m) for label, m in c.items()} for g, c in groups.items()},
        }
    return result


def markdown(result):
    """A table per estimate: overall, then each class."""
    lines = [
        (
            f"Surface `{result['surface']}`, {len(result['tiles'])} tiles, references"
            f" {', '.join(result['sources'])}, QC version {result['qc_version']}"
            f" ({result['qc_flags_at_version']:,} flags)."
        ),
        "",
        result["caveat"],
    ]
    if result["tiles_without_surface"]:
        lines += ["", f"No surface COG for tiles {result['tiles_without_surface']}."]
    if not result["qc_flags_at_version"]:
        lines += ["", "No QC flags at this version: every sounding counts as accepted."]
    near = result["estimates"]["surface"]["classes"]["confirmed_shoal"]["within 1 pixel"]
    if not near["pixels"]:
        lines += ["", "No confirmed shoals (`confirmed` for `cell_shoal`) at this version."]
    for name, est in result["estimates"].items():
        lines += ["", f"### {name}", "", "| Class | " + " | ".join(c[1] for c in COLUMNS) + " |",
                  "|---" * (len(COLUMNS) + 1) + "|"]  # fmt: skip
        rows = [("overall", est["overall"])] + [
            (f"{g}: {label}", m) for g, c in est["classes"].items() for label, m in c.items()
        ]
        for label, m in rows:
            cells = ["–" if m[key] is None else fmt.format(m[key]) for key, _, fmt in COLUMNS]
            lines.append(f"| {label} | " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"
