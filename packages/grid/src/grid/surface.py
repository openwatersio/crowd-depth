"""Depth surface: a raster per 1° tile, interpolated between nearby tracks.

The surface is on the cells' latitude and longitude grid: rows 2/3″ of latitude (about
20 m), columns widened by latitude band as the cells' are. A tile is gridded in an
equirectangular projection centred on it, a linear rescaling of latitude and
longitude, so `gdal_grid`'s search radius is in metres (within about 3% across a tile up to 70°, 5% at 80°)
and its pixels are exactly the latitude and longitude grid's. Interpolation needs a
sounding in every quadrant around a pixel, so it fills between tracks and never runs
past their ends. Depth areas and contours are cut from it; soundings never are.

What is interpolated is each pixel's median of vessels' medians; the depth is that
surface less K times σ (statistic.py). A pixel with a depth and no sounding is
interpolated, and its σ widens with its distance from the nearest sounding.

Each tile is a cloud-optimized GeoTIFF with four bands: depth (positive down), the
distance in metres to the nearest sounding, the soundings in the pixel, and σ. The whole
tile is interpolated, but only blocks with a sounding within the search radius are
blurred, guarded, measured and written; the rest are left out of the file, and read
as no data in every band.
"""

import contextlib
import math
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from rasterio.transform import from_bounds
from rasterio.windows import Window
from scipy.ndimage import gaussian_filter, minimum_filter
from scipy.spatial import cKDTree

from . import statistic
from .catalog import MIN_DEPTH_M
from .cells import BASE, CELL_SAMPLE, k_for
from .definitions import SURFACE
from .qc import HAZARD_M, MAX_DEPTH_M, QC_VERSION

NODATA = -9999.0
# Rows per tile: 2/3″ of latitude, two base rows.
ROWS = BASE // 2
RADIUS_M = SURFACE["interpolation_radius_m"]
# Smoothing, in metres, is added to every point's distance, so a sounded pixel takes its
# neighbours' depths too and doesn't keep its own value whole.
SMOOTHING_M = SURFACE["smoothing_m"]
ALGORITHM = (
    f"invdistnn:power=2:smoothing={SMOOTHING_M}:radius={RADIUS_M}:max_points=12:min_points=3"
    f":min_points_per_quadrant=1:nodata={NODATA}"
)
# The blur, in pixels: never toward deeper water, wide enough that busy and quiet water both
# read clearly.
SIGMA_PX = SURFACE["blur_px"]
# Base rows per pixel row and per pixel column.
PIXEL_BASE = 2
EARTH_M = 6378137.0
# Pixels a side of the blocks a tile is worked and stored in; blocks with no sounding
# within reach are skipped, and left out of the file.
BLOCK = 512

# An unconfirmed shoal QC judged improbable against its context (its track, its cell's
# median, other vessels nearby) doesn't affect the surface: it publishes as an unconfirmed
# sounding, the chart's warning there, and the surface is drawn from the other votes. One
# with no context to judge against, a cell shoal in a cell with no accepted median,
# votes like any accepted sounding.
UNJUDGED = "cell_unjudged"

# Each surface pixel's corrected soundings, from those QC accepted (not rejected, and not an
# unconfirmed shoal QC judged improbable, unless something confirmed it, nor a transit that
# lost the bottom), within the depths cells trust, with
# the pixel numbered on this tile's grid from its south-west corner; a neighboring tile's
# soundings get numbers outside it, which interpolation reads as a margin. A fixed sample
# per pixel and vessel is marked `keep`, so a moored boat costs fixed memory and can't
# sample other vessels out of the pixel.
POINTS = f"""
CREATE OR REPLACE TEMP TABLE surface_points AS
WITH wanted AS MATERIALIZED (
  SELECT * FROM (
    SELECT p.point_id, p.unique_id AS vessel, p.depth AS d, p.sigma, p.lost_bottom,
      floor((p.lat - $lat0) * {BASE} / 2)::INTEGER AS py,
      floor((p.lon - $lon0) * {BASE} / $k / 2)::INTEGER AS px
    FROM corrected_points_in($partition, [$tile], $rlo, $rhi) p
    WHERE p.depth_raw > 0 AND p.depth_raw <= {MAX_DEPTH_M} AND p.depth >= {MIN_DEPTH_M}
      AND NOT p.excluded AND NOT p.awaiting_tide
      -- As cells publish them: a transit that lost the bottom only where it reads shoal.
      AND NOT (p.lost_bottom AND p.depth >= {HAZARD_M})
  )
  -- Only the pixels wanted: a neighbor's strip within the search radius, say.
  WHERE py BETWEEN $pylo AND $pyhi AND px BETWEEN $pxlo AND $pxhi
),
-- Only these points' flags, so memory follows the tile, not its whole partition.
flags AS (
  -- A noisy track's soundings neither vote nor cap a pixel.
  SELECT point_id, bool_or(flag IN ('reject', 'noisy')) AS rejected,
    bool_or(flag = 'confirmed' AND reason = 'cell_shoal') AS confirmed,
    bool_or(flag = 'unconfirmed' AND reason <> '{UNJUDGED}') AND NOT bool_or(flag = 'confirmed')
      AS unconfirmed
  FROM lake.qc_flags WHERE cell_id = $partition AND qc_version = {QC_VERSION}
    AND point_id IN (SELECT point_id FROM wanted)
  GROUP BY point_id
),
pts AS (
  -- A transit that lost the bottom never votes: its soundings publish as shoals.
  SELECT w.* EXCLUDE (lost_bottom), coalesce(f.unconfirmed, false) OR w.lost_bottom AS unconfirmed,
    coalesce(f.confirmed, false) AS confirmed
  FROM wanted w LEFT JOIN flags f USING (point_id) WHERE NOT coalesce(f.rejected, false)
)
SELECT a.*, NOT a.unconfirmed
  AND hash(a.point_id) % greatest(1, ceil(n.n / {CELL_SAMPLE}))::UBIGINT = 0 AS keep
FROM pts a JOIN (SELECT py, px, vessel, count(*) AS n FROM pts GROUP BY ALL) n
  USING (py, px, vessel)
"""

# Each vessel's median in each pixel, and its median correction σ: what the statistic
# reads, one vote per vessel however fast it logs. One row per sounded pixel and vessel,
# so what Python holds of a tile is bounded by those, not its soundings.
ENTRIES = """
SELECT py, px, hash(vessel) AS v, median(d) AS m, median(sigma) AS s
FROM surface_points WHERE keep GROUP BY py, px, vessel ORDER BY py, px, v, m
"""

# Each sounded pixel's soundings, those of them that vote, and its shoalest confirmed
# shoal, which no pixel may be deeper than.
COUNTS = """
SELECT py, px, count(*) AS n, count(*) FILTER (WHERE NOT unconfirmed) AS votes,
  min(d) FILTER (WHERE confirmed) AS confirmed
FROM surface_points GROUP BY ALL
"""


def entries(con, params):
    """The entries and per-pixel counts for one tile's or neighbor strip's soundings."""
    con.execute(POINTS, params)
    got = con.execute(ENTRIES).fetchnumpy(), con.execute(COUNTS).fetchnumpy()
    con.execute("DROP TABLE surface_points")
    return got


def tiles(con):
    """Every tile with cells, with its 10° partition."""
    return con.execute(
        "SELECT DISTINCT tile_id, cell_id FROM lake.cells ORDER BY tile_id"
    ).fetchall()


def partition_of(lat0: int, lon0: int) -> int:
    """The 10° partition holding the 1° tile at (lat0, lon0), as ingest numbers them."""
    return min(lat0 // 10 + 9, 17) * 36 + min(lon0 // 10 + 18, 35)


def margin(con, lat0, lon0, k, cols, scale_x, scale_y):
    """Entries of the eight neighboring tiles within the search radius of this tile's
    edges, numbered on this tile's grid, as (py, px, vessel, m, s) arrays: interpolation and σ
    input only, so tracks either side of a whole-degree line are interpolated between
    as anywhere else."""
    rows_m = math.ceil(RADIUS_M / (scale_y / ROWS))
    cols_m = math.ceil(RADIUS_M / (scale_x / cols))
    edge = math.ceil(RADIUS_M / (scale_y / BASE))  # in the neighbor's base rows
    parts = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            lat, lon = lat0 + dy, (lon0 + dx + 180) % 360 - 180
            if (dy, dx) == (0, 0) or not -90 <= lat <= 89:
                continue
            rlo, rhi = {-1: (BASE - edge, BASE), 0: (0, BASE), 1: (0, edge)}[dy]
            # Across the antimeridian a neighbor's longitudes are a turn away from this
            # tile's: east of 179°E is -180°, so this tile's origin moves a turn west.
            turn = -360 if lon - lon0 < -1 else 360 if lon - lon0 > 1 else 0
            got, _ = entries(
                con,
                {"partition": partition_of(lat, lon), "tile": (lat + 90) * 360 + lon + 180,
                 "lat0": lat0, "lon0": lon0 + turn, "k": k, "rlo": rlo, "rhi": rhi,
                 "pylo": -rows_m, "pyhi": ROWS + rows_m - 1,
                 "pxlo": -cols_m, "pxhi": cols + cols_m - 1},
            )  # fmt: skip
            parts.append(
                (
                    np.asarray(got["py"], dtype=np.int64),
                    np.asarray(got["px"], dtype=np.int64),
                    np.asarray(got["v"], dtype=np.uint64),
                    np.asarray(got["m"], dtype=np.float64),
                    np.asarray(got["s"], dtype=np.float64),
                )
            )
    if not parts:
        return (np.empty(0, np.int64),) * 2 + (np.empty(0, np.uint64),) + (np.empty(0),) * 2
    return tuple(np.concatenate(c) for c in zip(*parts))


def build_tile(con, tile_id: int, partition: int, out: Path):
    """Grid one tile into `out/{tile_id}.tif`. Returns its path, or None when the tile has
    no soundings."""
    lat0, lon0 = tile_id // 360 - 90, tile_id % 360 - 180
    k = k_for(lat0)
    # ponytail: past about 86° a tile has an odd number of base columns, so its last
    # surface column holds one; pad the grid if polar tiles ever matter
    cols = math.ceil(BASE / k / PIXEL_BASE)
    params = {"partition": partition, "tile": tile_id, "lat0": lat0, "lon0": lon0, "k": k,
              "rlo": 0, "rhi": BASE, "pylo": -ROWS, "pyhi": 2 * ROWS, "pxlo": -cols,
              "pxhi": 2 * cols}  # fmt: skip
    own, counted = entries(con, params)
    if not len(counted["py"]):
        return None
    # The tile in metres east and north of its south-west corner, scaled at its centre.
    scale_x = EARTH_M * math.cos(math.radians(lat0 + 0.5)) * math.pi / 180
    scale_y = EARTH_M * math.pi / 180
    dx, dy = scale_x / cols, scale_y / ROWS
    shape = (ROWS, cols)
    # A tile's own soundings always land on its pixels, even on its north or east edge.
    my, mx, mv, mm, ms = margin(con, lat0, lon0, k, cols, scale_x, scale_y)
    # Each vessel smoothed along its own coverage, this tile's and the margin's together.
    epx, epy, em, es = statistic.smoothed(
        np.concatenate([np.clip(own["px"].astype(np.int64), 0, cols - 1), mx]),
        np.concatenate([np.clip(own["py"].astype(np.int64), 0, ROWS - 1), my]),
        np.concatenate([np.asarray(own["v"], dtype=np.uint64), mv]),
        np.concatenate([np.asarray(own["m"], dtype=np.float64), mm]),
        np.concatenate([np.asarray(own["s"], dtype=np.float64), ms]),
    )
    upx, upy, _, medians = statistic.pixels(epx, epy, em)
    # Accumulated, not assigned: a sounding on the tile's north or east edge is its own
    # group in SQL but shares the last pixel, and must not overwrite its values.
    cpy = np.clip(counted["py"].astype(np.int64), 0, ROWS - 1)
    cpx = np.clip(counted["px"].astype(np.int64), 0, cols - 1)
    count = np.zeros(shape, dtype=np.float32)
    np.add.at(count, (ROWS - 1 - cpy, cpx), np.asarray(counted["n"], dtype=np.float32))
    confirmed = np.full(shape, np.inf, dtype=np.float32)
    # NULL, a pixel without one, comes back masked: as NaN, never as its 0 fill.
    shoal = np.ma.filled(np.ma.asarray(counted["confirmed"], dtype=np.float32), np.nan)
    has = ~np.isnan(shoal)
    np.minimum.at(confirmed, (ROWS - 1 - cpy[has], cpx[has]), shoal[has])
    # Every pixel with a vote, this tile's and its neighbors', in metres: distance is to
    # the nearest, wherever it is, and a pixel holding only shoals the surface ignores
    # isn't sounded for it.
    voted = np.asarray(counted["votes"]) > 0
    sounded = cKDTree(
        np.column_stack(
            [np.concatenate([cpx[voted], mx]) * dx, np.concatenate([cpy[voted], my]) * dy]
        )
    )
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{tile_id}.tif"
    with tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None) as tmp:
        # A tile whose soundings are all contradicted shoals has no votes: nothing to draw.
        grid = (
            interpolate(Path(tmp), upx, upy, medians, scale_x, scale_y, cols) if len(upx) else None
        )
        # A pixel has a depth only within the search radius of a point, and then has one
        # of the tile's own soundings within it too: the quadrant facing into the tile
        # needs one. So only blocks within that reach of a point have data, and a block's
        # depths and distances depend only on pixels within that reach of it, or within
        # the blur's (4σ), whichever is wider.
        reach = (math.ceil(RADIUS_M / dy) + 1, math.ceil(RADIUS_M / dx) + 1)
        blur_px = math.ceil(4 * SIGMA_PX)
        halo = (max(reach[0], blur_px), max(reach[1], blur_px))
        # Blocks around the votes, and around every sounded pixel, so the soundings band
        # reaches each.
        at = (np.concatenate([ROWS - 1 - upy, ROWS - 1 - cpy]), np.concatenate([upx, cpx]))
        # A point's reach touches at most two blocks each way, so its four corners'
        # blocks are every block it reaches.
        assert 2 * max(reach) < BLOCK, "the search radius reaches past a block"
        blocks = set()
        for sr_ in (-1, 1):
            for sc_ in (-1, 1):
                r = np.clip(at[0] + sr_ * reach[0], 0, ROWS - 1) // BLOCK
                c = np.clip(at[1] + sc_ * reach[1], 0, cols - 1) // BLOCK
                blocks |= set(zip(r.tolist(), c.tolist()))
        windows = {}
        for br, bc in sorted(blocks):
            r0, c0 = br * BLOCK, bc * BLOCK
            r1, c1 = min(r0 + BLOCK, ROWS), min(c0 + BLOCK, cols)
            wr0, wc0 = max(r0 - halo[0], 0), max(c0 - halo[1], 0)
            wr1, wc1 = min(r1 + halo[0], ROWS), min(c1 + halo[1], cols)
            windows[br, bc] = (r0, c0, r1, c1, wr0, wc0, wr1, wc1)
        # The blurred surface first, block by block, for σ's spread around it where a
        # window is too thin for a plane, as the statistic was measured.
        central = {
            key: np.full((r1 - r0, c1 - c0), NODATA, dtype=np.float32)
            for key, (r0, c0, r1, c1, *_) in windows.items()
        }
        with contextlib.ExitStack() as stack:
            src = stack.enter_context(rasterio.open(grid)) if grid else None
            for key, (r0, c0, r1, c1, wr0, wc0, wr1, wc1) in windows.items() if src else ():
                window = src.read(1, window=Window(wc0, wr0, wc1 - wc0, wr1 - wr0))
                central[key] = blur(window)[r0 - wr0 : r1 - wr0, c0 - wc0 : c1 - wc0]
        rows_at, cols_at = ROWS - 1 - upy, upx
        inside = (rows_at >= 0) & (rows_at < ROWS) & (cols_at >= 0) & (cols_at < cols)
        at_central = np.full(len(upx), np.nan)
        blocks_at = (rows_at // BLOCK) * (cols // BLOCK + 1) + cols_at // BLOCK
        for key, block in central.items():
            mine = inside & (blocks_at == key[0] * (cols // BLOCK + 1) + key[1])
            value = block[rows_at[mine] % BLOCK, cols_at[mine] % BLOCK]
            at_central[mine] = np.where(value == NODATA, np.nan, value)
        # Interpolation needs a sounding in every quadrant, so the outermost tracks' own
        # pixels have no surface: there, as past the tile's edge, the pixel's own median.
        at_central = np.where(np.isnan(at_central), medians, at_central)

        def sigma_of(qx, qy, distance):
            return np.empty(0)  # no votes, so no pixel has a depth

        if len(upx):
            upx, upy, _, spread, csig = statistic.sigma_b(epx, epy, em, es, central=at_central)
            sigma_of = statistic.sigma_at(upx, upy, spread, csig)
        sparse = Path(tmp) / "sparse.tif"
        with open_sparse(sparse, lon0, lat0, shape) as dst:
            for key, (r0, c0, r1, c1, wr0, wc0, wr1, wc1) in windows.items():
                inner = np.s_[r0 - wr0 : r1 - wr0, c0 - wc0 : c1 - wc0]
                block = np.s_[r0:r1, c0:c1]
                win = np.s_[wr0:wr1, wc0:wc1]
                surface = central[key]
                distance = np.full(surface.shape, NODATA, dtype=np.float32)
                sigma = np.full(surface.shape, NODATA, dtype=np.float32)
                rr, cc = np.nonzero(surface != NODATA)
                qx, qy = cc + c0, ROWS - 1 - (rr + r0)
                distance[rr, cc] = sounded.query(np.column_stack([qx * dx, qy * dy]))[0]
                sigma[rr, cc] = sigma_of(qx, qy, distance[rr, cc])
                depth = finish(surface, sigma, around(confirmed[win])[inner])
                distance[depth == NODATA] = NODATA
                sigma[depth == NODATA] = NODATA
                dst.write(
                    np.stack([depth, distance, count[block], sigma]),
                    window=Window(c0, r0, c1 - c0, r1 - r0),
                )
        rasterio.shutil.copy(sparse, path, driver="COG", compress="deflate", sparse_ok=True)
    return path


def interpolate(tmp, px, py, values, scale_x, scale_y, cols):
    """`values` at pixels (px, py) interpolated over the tile with `gdal_grid`; the
    raster's path."""
    points = tmp / "points.csv"
    # Each pixel's centre, in metres.
    np.savetxt(
        points,
        np.column_stack([px + 0.5, py + 0.5, values]) * [scale_x / cols, scale_y / ROWS, 1],
        delimiter=",", header="x,y,d", comments="", fmt="%.3f",
    )  # fmt: skip
    vrt = tmp / "points.vrt"
    vrt.write_text(
        f"""<OGRVRTDataSource><OGRVRTLayer name="points"><SrcDataSource>{points}</SrcDataSource>
<GeometryType>wkbPoint</GeometryType>
<GeometryField encoding="PointFromColumns" x="x" y="y" z="d"/></OGRVRTLayer></OGRVRTDataSource>"""
    )
    grid = tmp / "grid.tif"
    subprocess.run(
        [
            "gdal_grid", "-q", "-a", ALGORITHM, "-zfield", "d", "-l", "points",
            "-txe", "0", str(scale_x), "-tye", str(scale_y), "0",
            "-outsize", str(cols), str(ROWS), "-ot", "Float32", str(vrt), str(grid),
        ],
        check=True,
    )  # fmt: skip
    return grid


def blur(depth):
    """Blur lightly, never deeper than the interpolation."""
    valid = depth != NODATA
    weights = gaussian_filter(valid.astype(np.float32), SIGMA_PX)
    blurred = gaussian_filter(np.where(valid, depth, 0), SIGMA_PX)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(valid, np.minimum(blurred / weights, depth), NODATA).astype(np.float32)


def around(confirmed):
    """Each pixel's shoalest confirmed shoal in it or a pixel next to it."""
    return minimum_filter(confirmed, size=3, mode="constant", cval=np.inf)


def finish(surface, sigma, around):
    """The depth: the blurred `surface` less K `sigma`, never deeper in any pixel than a
    confirmed shoal `around` it (in it or a pixel next to it).

    Depth areas follow the surface between pixel centres, so a shoal held at its own
    pixel's centre alone would cover only part of that pixel; carried to the pixels
    around it, it covers all of its own. Shoals may be enlarged, never drawn deeper.
    A pixel the interpolator leaves empty stays empty, shoal or not, as at a lone track
    or a track's end: the shoal shows there only as a sounding.
    """
    valid = surface != NODATA
    # The margin alone never makes water drying: below 0 only where the surface or a
    # confirmed shoal is. Never past the drying band's floor, which the overlay's bands
    # start from.
    floor = np.maximum(np.minimum(np.minimum(surface, around), 0), MIN_DEPTH_M)
    depth = np.maximum(np.minimum(surface - statistic.K * sigma, around), floor)
    return np.where(valid, depth, NODATA).astype(np.float32)


def open_sparse(path, lon0, lat0, shape):
    """A tiled GeoTIFF for a 1° tile's bands, which leaves out blocks never written."""
    rows, cols = shape
    dst = rasterio.open(
        path, "w", driver="GTiff", width=cols, height=rows, count=4, dtype="float32",
        crs="EPSG:4326", transform=from_bounds(lon0, lat0, lon0 + 1, lat0 + 1, cols, rows),
        nodata=NODATA, tiled=True, blockxsize=BLOCK, blockysize=BLOCK, sparse_ok=True,
    )  # fmt: skip
    for band, name in enumerate(("depth", "distance_m", "soundings", "sigma"), start=1):
        dst.set_band_description(band, name)
    return dst
